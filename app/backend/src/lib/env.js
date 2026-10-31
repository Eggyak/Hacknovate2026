/**
 * Configuration, read once at boot.
 *
 * Nothing here has a secret for a default. A missing credential degrades the
 * feature that needs it and says so through /api/health - it never falls back
 * to a stub that pretends to work, because a grievance portal that silently
 * fakes a transcription is worse than one that admits it cannot hear you.
 */

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : String(v);
}

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export const env = {
  nodeEnv: str('NODE_ENV', 'production'),
  port: num('PORT', 8120),
  publicUrl: str('PUBLIC_URL', 'https://hacknovate2026.visioncoders.in'),

  database: {
    url: str('DATABASE_URL'),
  },

  jwt: {
    secret: str('JWT_SECRET'),
    ttlSeconds: num('JWT_TTL_SECONDS', 60 * 60 * 12),
  },

  azureSpeech: {
    key: str('AZURE_SPEECH_KEY'),
    region: str('AZURE_SPEECH_REGION', 'eastus'),
    // The resource endpoint, used for the Fast Transcription REST API.
    endpoint: str('AZURE_SPEECH_ENDPOINT', ''),
  },

  azureTranslator: {
    key: str('AZURE_TRANSLATOR_KEY'),
    region: str('AZURE_TRANSLATOR_REGION', ''),
    endpoint: str('AZURE_TRANSLATOR_ENDPOINT', 'https://api.cognitive.microsofttranslator.com'),
  },

  mistral: {
    key: str('MISTRAL_API_KEY'),
    apiKey: str('MISTRAL_API_KEY'),
    // Free Mistral accounts meter quota PER MODEL, and a model can sit at zero
    // while another on the same key works fine. Keep this configurable so a
    // dead model is an env change, not a redeploy of code.
    model: str('MISTRAL_MODEL', 'ministral-14b-latest'),
    timeoutMs: num('MISTRAL_TIMEOUT_MS', 20_000),
  },

  // The department workspace. A separate service with its own database; we
  // reach it over the container network, never through its public hostname.
  govt: {
    baseUrl: str('GOVT_API_URL'),
    serviceKey: str('MHA_INTAKE_SERVICE_KEY'),
    syncIntervalMs: num('GOVT_SYNC_INTERVAL_MS', 5 * 60 * 1000),
  },

  otp: {
    // n8n owns delivery. We own generation, hashing, expiry and rate limiting.
    webhookUrl: str('N8N_OTP_WEBHOOK_URL'),
    apiKey: str('N8N_OTP_API_KEY'),
    ttlSeconds: num('OTP_TTL_SECONDS', 300),
    length: num('OTP_LENGTH', 6),
    maxAttempts: num('OTP_MAX_ATTEMPTS', 5),
    resendCooldownSeconds: num('OTP_RESEND_COOLDOWN_SECONDS', 60),
    // When true the generated code is returned in the API response. Intended
    // only for pre-Twilio bring-up; refuses to engage outside development.
    echoForDev: bool('OTP_ECHO_FOR_DEV', false),
  },

  uploads: {
    dir: str('UPLOAD_DIR', '/data/uploads'),
    maxBytes: num('UPLOAD_MAX_BYTES', 10 * 1024 * 1024),
    maxFiles: num('UPLOAD_MAX_FILES', 5),
  },

  sla: {
    days: num('SLA_DAYS', 21),
  },

  /*
   * Spoken status callbacks.
   *
   * A webhook, like the OTP path, and for the same reason: the telephony
   * credentials belong to the workflow engine, not to this process. This
   * service decides a call is owed and what it should say; it cannot dial.
   */
  callbacks: {
    webhookUrl: str('N8N_CALLBACK_WEBHOOK_URL'),
    secret: str('CALLBACK_SHARED_SECRET'),
  },
};

/** Feature availability, surfaced to the UI so it never offers a dead button. */
export function capabilities() {
  return {
    speech: Boolean(env.azureSpeech.key),
    // Either provider can produce the English rendering the schema asks for.
    translation: Boolean(env.azureTranslator.key) || Boolean(env.mistral.apiKey),
    llm: Boolean(env.mistral.apiKey),
    smsOtp: Boolean(env.otp.webhookUrl),
    departmentSync: Boolean(env.govt.baseUrl && env.govt.serviceKey),
    // A spoken callback needs a dialler to hand the job to AND a voice to
    // read it with; either one missing means the button should not appear.
    spokenCallback: Boolean(env.callbacks.webhookUrl && env.azureSpeech.key),
  };
}

/** Problems that must stop the process, as opposed to degrading a feature. */
export function fatalConfigProblems() {
  const problems = [];
  if (!env.database.url) problems.push('DATABASE_URL is not set');
  if (!env.jwt.secret) problems.push('JWT_SECRET is not set');
  if (env.jwt.secret && env.jwt.secret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters');
  }
  if (env.otp.echoForDev && env.nodeEnv === 'production') {
    problems.push('OTP_ECHO_FOR_DEV must not be enabled in production');
  }
  return problems;
}
