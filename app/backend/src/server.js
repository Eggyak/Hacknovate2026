import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import { env, capabilities, fatalConfigProblems } from './lib/env.js';
import { migrate } from './lib/migrate.js';
import { healthy, pool } from './lib/db.js';
import { loadCitizen } from './lib/auth.js';
import { authRouter } from './routes/auth.js';
import { chatRouter } from './routes/chat.js';
import { speechRouter } from './routes/speech.js';
import { grievanceRouter } from './routes/grievances.js';
import { i18nRouter, i18nStats } from './routes/i18n.js';
import { mobileRouter } from './routes/mobile.js';
import { probe as speechProbe } from './services/azureSpeech.js';
import { probe as translateProbe } from './services/translate.js';
import { snapshot as mistralSnapshot } from './services/mistral.js';
import { purgeExpired } from './services/otp.js';
import { retryPending, refreshStatuses, configured as govtConfigured } from './services/govtIntake.js';
import { LANGUAGES } from './data/languages.js';
import { DIVISIONS } from './data/divisions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..', 'public');

const app = express();
app.set('trust proxy', 1); // Behind Traefik.

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The Azure Speech browser SDK is loaded from a CDN and opens a
        // websocket to the regional speech endpoint.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://aka.ms'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'", 'https://*.cognitiveservices.azure.com', 'wss://*.stt.speech.microsoft.com', 'https://*.tts.speech.microsoft.com', 'https://*.api.cognitive.microsoft.com'],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(loadCitizen);

/**
 * Health, and deliberately detailed.
 *
 * A portal that silently loses its speech credentials and keeps serving a
 * microphone button is worse than one that is plainly degraded, so this
 * reports each dependency separately and the UI reads it on load.
 */
app.get('/api/health', async (_req, res) => {
  const [db, speech, translation] = await Promise.all([healthy(), speechProbe(), translateProbe()]);
  // Not probed: a health check that burns a request from a 10-per-minute
  // budget would itself cause the throttling it is meant to report. The
  // counters say everything useful without spending anything.
  const llm = mistralSnapshot();

  const ok = db;
  return res.status(ok ? 200 : 503).json({
    ok,
    service: 'mha-samadhan',
    version: '1.0.0',
    time: new Date().toISOString(),
    dependencies: { database: { ok: db }, speech, translation, llm, interface: i18nStats() },
    capabilities: capabilities(),
    counts: { languages: LANGUAGES.length, divisions: DIVISIONS.length },
    sla: { days: env.sla.days },
  });
});

app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);
app.use('/api/speech', speechRouter);
app.use('/api/grievances', grievanceRouter);
app.use('/api/i18n', i18nRouter);
// The Android client's contract: what this portal is, and what to show.
app.use('/api/mobile', mobileRouter);

app.use(
  express.static(FRONTEND, {
    maxAge: '1h',
    setHeaders: (res, path) => {
      // The shell must never be cached, or a deploy leaves stale JS behind.
      if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

// Client-side routing: anything that is not an API call renders the app.
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(join(FRONTEND, 'index.html'));
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err.code || 'internal_error',
    message: status >= 500 ? 'Something went wrong on our side.' : err.message,
    ...(err.errors ? { errors: err.errors } : {}),
  });
});

async function start() {
  const problems = fatalConfigProblems();
  if (problems.length > 0) {
    console.error('[boot] refusing to start:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  await mkdir(env.uploads.dir, { recursive: true });
  await migrate();

  const caps = capabilities();
  console.log(`[boot] speech=${caps.speech} translation=${caps.translation} llm=${caps.llm} sms=${caps.smsOtp} department=${caps.departmentSync}`);
  if (!caps.translation) {
    console.log('[boot] no translator configured: complaints will be routed and stored in the original language, with no English rendering.');
  }

  /*
   * Sweep for complaints that never reached the department.
   *
   * Forwarding is attempted when a complaint is filed, but the workspace may
   * be restarting, or a translation may not have finished. Without this a
   * complaint that failed once would sit unsent forever, because nothing
   * would ever look at it again - which is the worst failure this system has.
   */
  if (govtConfigured()) {
    setInterval(() => {
      retryPending().then((r) => {
        if (r.attempted > 0) console.log(`[govt] retried ${r.attempted}, forwarded ${r.forwarded}`);
      }).catch((e) => console.error('[govt] retry sweep failed', e.message));

      // And reflect whatever the department has done since. Their workspace
      // owns the lifecycle once a case reaches a desk; we only mirror it.
      refreshStatuses().then((r) => {
        if (r.changed > 0) console.log(`[govt] ${r.changed} case(s) moved`);
      }).catch((e) => console.error('[govt] status sweep failed', e.message));
    }, env.govt.syncIntervalMs).unref();
  }

  // Expired codes are useless and are a liability; sweep them hourly.
  setInterval(() => {
    purgeExpired().catch((e) => console.error('[otp] purge failed', e.message));
  }, 3_600_000).unref();

  const server = app.listen(env.port, () => {
    console.log(`[boot] MHA Samadhan listening on :${env.port}`);
  });

  const shutdown = (signal) => {
    console.log(`[shutdown] ${signal}`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[boot] failed', err);
  process.exit(1);
});
