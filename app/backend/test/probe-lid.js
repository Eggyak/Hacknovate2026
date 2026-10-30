/**
 * Which locales does Azure's language identification actually accept?
 *
 * There is no published list and the batch-transcription locale list is
 * misleading - it contains or-IN, which LID rejects outright with
 * InvalidArgument and kills the websocket before a word is heard.
 *
 * So ask Azure. Each locale is offered as a LID candidate alongside en-US;
 * an unsupported one is refused on connect, with the offending locale named
 * in the error, and no audio is needed to find out.
 *
 *   docker exec mha-api node test/probe-lid.js
 */

import sdk from 'microsoft-cognitiveservices-speech-sdk';
import { env } from '../src/lib/env.js';
import { LANGUAGES } from '../src/data/languages.js';

const TIMEOUT_MS = 9_000;

function probe(locale) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { recognizer.close(); } catch { /* already gone */ }
      resolve(result);
    };

    const cfg = sdk.SpeechConfig.fromSubscription(env.azureSpeech.key, env.azureSpeech.region);
    cfg.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, 'Continuous');

    // Two candidates: identification needs something to choose between.
    const auto = sdk.AutoDetectSourceLanguageConfig.fromLanguages(
      locale === 'en-US' ? ['en-US', 'de-DE'] : ['en-US', locale],
    );

    const push = sdk.AudioInputStream.createPushStream();
    const audio = sdk.AudioConfig.fromStreamInput(push);
    const recognizer = sdk.SpeechRecognizer.FromConfig(cfg, auto, audio);

    recognizer.canceled = (_s, e) => {
      const detail = e.errorDetails || '';
      if (/doesn't support|does not support|InvalidArgument/i.test(detail)) {
        done({ ok: false, reason: detail.slice(0, 120) });
      } else {
        // Any other cancellation means the session was accepted and then
        // ended for an unrelated reason - which is a pass for our purposes.
        done({ ok: true, note: detail.slice(0, 60) });
      }
    };

    /*
     * Deliberately NOT resolving on sessionStarted.
     *
     * That event fires when the socket connects, BEFORE the service has
     * validated the candidate list. Treating it as success made every locale
     * look supported while the browser was plainly being refused - the
     * refusal arrives a moment later, as a cancellation. Only `canceled` and
     * the timeout decide anything here.
     */

    recognizer.startContinuousRecognitionAsync(
      () => {
        // Silence is enough; the refusal follows the handshake.
        push.write(new ArrayBuffer(32_000));
      },
      (err) => done({ ok: false, reason: String(err).slice(0, 120) }),
    );

    // No refusal within the window means the candidate list was accepted.
    setTimeout(() => done({ ok: true, note: 'accepted' }), TIMEOUT_MS);
  });
}

async function main() {
  if (!env.azureSpeech.key) {
    console.error('AZURE_SPEECH_KEY is not set');
    process.exit(1);
  }

  const supported = [];
  const rejected = [];

  for (const lang of LANGUAGES) {
    process.stdout.write(`${lang.locale.padEnd(8)} ${lang.name.padEnd(11)}`);
    const r = await probe(lang.locale);
    if (r.ok) {
      supported.push(lang.locale);
      console.log(`SUPPORTED   ${r.note || ''}`);
    } else {
      rejected.push(lang.locale);
      console.log(`REJECTED    ${r.reason}`);
    }
  }

  console.log('\n--- result ---');
  console.log('LID supports :', supported.join(', ') || 'none');
  console.log('LID rejects  :', rejected.join(', ') || 'none');
  console.log('\nPut the rejected list into LID_UNSUPPORTED in src/data/languages.js');
  process.exit(0);
}

main();
