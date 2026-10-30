/**
 * The 14 languages MHA Samadhan speaks and writes.
 *
 * Every entry is backed by a REAL Azure neural voice (verified against
 * /cognitiveservices/voices/list on the configured resource) and a REAL
 * Azure speech-to-text locale. Nothing here is decorative.
 *
 * `script` drives offline language detection for TYPED input (see
 * services/languageDetect.js). Several languages share a script, so
 * `script` alone is never sufficient - the detector disambiguates
 * Devanagari (hi/mr/ne) and Bengali (bn/as) with marker lexicons.
 */

export const LANGUAGES = [
  {
    code: 'en', locale: 'en-IN', name: 'English', native: 'English',
    script: 'Latin', dir: 'ltr',
    voice: { female: 'en-IN-NeerjaNeural', male: 'en-IN-PrabhatNeural' },
  },
  {
    code: 'hi', locale: 'hi-IN', name: 'Hindi', native: 'हिन्दी',
    script: 'Devanagari', dir: 'ltr',
    voice: { female: 'hi-IN-SwaraNeural', male: 'hi-IN-MadhurNeural' },
  },
  {
    code: 'bn', locale: 'bn-IN', name: 'Bengali', native: 'বাংলা',
    script: 'Bengali', dir: 'ltr',
    voice: { female: 'bn-IN-TanishaaNeural', male: 'bn-IN-BashkarNeural' },
  },
  {
    code: 'ta', locale: 'ta-IN', name: 'Tamil', native: 'தமிழ்',
    script: 'Tamil', dir: 'ltr',
    voice: { female: 'ta-IN-PallaviNeural', male: 'ta-IN-ValluvarNeural' },
  },
  {
    code: 'te', locale: 'te-IN', name: 'Telugu', native: 'తెలుగు',
    script: 'Telugu', dir: 'ltr',
    voice: { female: 'te-IN-ShrutiNeural', male: 'te-IN-MohanNeural' },
  },
  {
    code: 'mr', locale: 'mr-IN', name: 'Marathi', native: 'मराठी',
    script: 'Devanagari', dir: 'ltr',
    voice: { female: 'mr-IN-AarohiNeural', male: 'mr-IN-ManoharNeural' },
  },
  {
    code: 'gu', locale: 'gu-IN', name: 'Gujarati', native: 'ગુજરાતી',
    script: 'Gujarati', dir: 'ltr',
    voice: { female: 'gu-IN-DhwaniNeural', male: 'gu-IN-NiranjanNeural' },
  },
  {
    code: 'kn', locale: 'kn-IN', name: 'Kannada', native: 'ಕನ್ನಡ',
    script: 'Kannada', dir: 'ltr',
    voice: { female: 'kn-IN-SapnaNeural', male: 'kn-IN-GaganNeural' },
  },
  {
    code: 'ml', locale: 'ml-IN', name: 'Malayalam', native: 'മലയാളം',
    script: 'Malayalam', dir: 'ltr',
    voice: { female: 'ml-IN-SobhanaNeural', male: 'ml-IN-MidhunNeural' },
  },
  {
    code: 'pa', locale: 'pa-IN', name: 'Punjabi', native: 'ਪੰਜਾਬੀ',
    script: 'Gurmukhi', dir: 'ltr',
    voice: { female: 'pa-IN-VaaniNeural', male: 'pa-IN-OjasNeural' },
  },
  {
    code: 'or', locale: 'or-IN', name: 'Odia', native: 'ଓଡ଼ିଆ',
    script: 'Odia', dir: 'ltr', lid: false,
    voice: { female: 'or-IN-SubhasiniNeural', male: 'or-IN-SukantNeural' },
  },
  {
    code: 'as', locale: 'as-IN', name: 'Assamese', native: 'অসমীয়া',
    script: 'Bengali', dir: 'ltr', lid: false,
    voice: { female: 'as-IN-YashicaNeural', male: 'as-IN-PriyomNeural' },
  },
  {
    code: 'ur', locale: 'ur-IN', name: 'Urdu', native: 'اردو',
    script: 'Arabic', dir: 'rtl',
    voice: { female: 'ur-IN-GulNeural', male: 'ur-IN-SalmanNeural' },
  },
  {
    code: 'ne', locale: 'ne-NP', name: 'Nepali', native: 'नेपाली',
    script: 'Devanagari', dir: 'ltr',
    voice: { female: 'ne-NP-HemkalaNeural', male: 'ne-NP-SagarNeural' },
  },
];

export const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
export const BY_LOCALE = new Map(LANGUAGES.map((l) => [l.locale, l]));

export function byCode(code) {
  return BY_CODE.get(String(code || '').toLowerCase().split('-')[0]) || null;
}

/**
 * When identification is impossible, recognise the chosen language outright.
 *
 * Returns a locale to pin recognition to, or null to let identification run.
 * This is what keeps Odia and Assamese usable by voice at all: they lose
 * automatic detection, not the microphone.
 */
export function speechLocaleFor(code) {
  const lang = byCode(code);
  return lang && !lidSupported(lang) ? lang.locale : null;
}

export function byLocale(locale) {
  if (!locale) return null;
  return BY_LOCALE.get(locale) || byCode(String(locale).split('-')[0]);
}

/**
 * Azure continuous language identification accepts at most 10 candidate
 * locales per recognition session, but we support 14 languages. When the
 * caller cannot evaluate all 14 at once we narrow the field deterministically:
 *
 *   1. the language the citizen explicitly chose (if any)
 *   2. English and Hindi - the two link languages, always in play
 *   3. languages native to the citizen's state, from their pincode
 *   4. remaining languages by national speaker population, to fill the slots
 *
 * The result is a real 14-language system that is honest about evaluating 10
 * candidates per utterance. `preferred` and `stateLanguages` may be empty.
 */
export const LID_MAX_CANDIDATES = 10;

/**
 * Azure transcribes these two perfectly well, but refuses to IDENTIFY them:
 * offering or-IN or as-IN as a candidate is answered with InvalidArgument and
 * the websocket is closed before a word is heard. Determined by probing the
 * service directly (test/probe-lid.js) - there is no published list, and the
 * batch-transcription locale list includes both, so it cannot be trusted for
 * this.
 *
 * They are therefore excluded from identification and recognised explicitly
 * instead: a citizen who has chosen Odia is transcribed AS Odia rather than
 * having their language guessed. See speechLocaleFor().
 */
export function lidSupported(lang) {
  return lang ? lang.lid !== false : false;
}

const POPULARITY = ['hi', 'bn', 'mr', 'te', 'ta', 'gu', 'ur', 'kn', 'or', 'ml', 'pa', 'as', 'ne'];

export function buildLidCandidates({ preferred = null, stateLanguages = [] } = {}) {
  const out = [];
  const push = (code) => {
    const lang = byCode(code);
    // A locale Azure will not identify must never reach the candidate list:
    // one of them refuses the whole session, not just itself.
    if (lang && lidSupported(lang) && !out.includes(lang.locale) && out.length < LID_MAX_CANDIDATES) {
      out.push(lang.locale);
    }
  };

  push(preferred);
  push('en');
  push('hi');
  for (const code of stateLanguages) push(code);
  for (const code of POPULARITY) push(code);

  return out;
}
