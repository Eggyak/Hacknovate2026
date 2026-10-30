import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/services/classifier.js';

/** Complaints in many languages, each with the division that should own it. */
const CASES = [
  ['cyber', 'I received an OTP call and fifty thousand rupees was debited by UPI fraud'],
  ['cyber', 'मेरे बैंक खाते से ओटीपी के जरिए धोखाधड़ी हुई और पैसे कट गए'],
  ['cyber', 'எனது வங்கிக் கணக்கிலிருந்து சைபர் மோசடி மூலம் பணம் எடுக்கப்பட்டது'],
  ['cyber', 'ଆମର ବ୍ୟାଙ୍କ ଖାତାରୁ ସାଇବର ଠକେଇ ହୋଇଛି'],
  ['foreigners', 'My OCI card application and visa renewal has been pending for months'],
  ['foreigners', 'मेरा वीजा और पासपोर्ट नवीनीकरण लंबित है'],
  ['disaster', 'Our house collapsed in the cyclone and we have not received any relief compensation'],
  ['disaster', 'বন্যায় আমাদের ঘর ভেসে গেছে, ত্রাণ পাইনি'],
  ['freedom_fighters', 'My samman pension PPO has not been credited for six months'],
  ['capf', 'A CRPF jawan committed misconduct at the checkpoint'],
  ['fcra', 'This NGO is violating FCRA rules on foreign contribution'],
  ['ut', 'Garbage is not collected in our ward by the municipal corporation in Delhi'],
  ['internal_security', 'My arms licence application is pending and there is narcotics smuggling here'],
  ['counter_terror', 'A social media handle is spreading terrorism propaganda and radicalization'],
  ['lwe_ne', 'Naxal maoist insurgency activity is reported in our village'],
  ['border', 'The border fencing near our village post is broken and BADP funds are misused'],
  ['judicial', 'I am filing a mercy petition for a prisoner in the central jail'],
  ['police', 'This is a gallantry award nomination for an IPS officer'],
  ['centre_state', 'There is an inter-state boundary issue between the two states'],
  ['internal_admin', 'My RTI application reference number has received no reply'],
];

test('routes complaints to the right MHA division across languages', () => {
  const failures = [];
  for (const [expected, text] of CASES) {
    const got = classify(text);
    if (got.divisionId !== expected) {
      failures.push(
        `"${text.slice(0, 45)}..." expected ${expected}, got ${got.divisionId} (conf ${got.confidence})`,
      );
    }
  }
  assert.deepEqual(failures, [], `misrouted:\n${failures.join('\n')}`);
});

test('every routing decision carries its evidence', () => {
  for (const [, text] of CASES) {
    const got = classify(text);
    assert.ok(got.matched.length > 0, `no evidence for: ${text}`);
    assert.equal(got.method, 'weighted-multilingual-lexicon');
    for (const m of got.matched) {
      assert.ok(m.term && m.weight >= 1, 'malformed evidence entry');
    }
  }
});

test('routes natively, with no translation available', () => {
  // The native lexicon alone must be sufficient - no English text supplied.
  const native = [
    ['cyber', 'ಸೈಬರ್ ವಂಚನೆಯಿಂದ ನನ್ನ ಬ್ಯಾಂಕ್ ಹಣ ಹೋಗಿದೆ'],
    ['disaster', 'ചുഴലിക്കാറ്റിൽ ഞങ്ങളുടെ വീട് തകർന്നു, ദുരിതാശ്വാസം കിട്ടിയില്ല'],
    ['judicial', 'ਮੇਰਾ ਰਿਸ਼ਤੇਦਾਰ ਜੇਲ੍ਹ ਵਿੱਚ ਹੈ ਅਤੇ ਅਦਾਲਤ ਦਾ ਕੇਸ ਚੱਲ ਰਿਹਾ ਹੈ'],
    ['counter_terror', 'سوشل میڈیا پر دہشت گردی کا پرچار ہو رہا ہے'],
  ];
  for (const [expected, text] of native) {
    const got = classify(text);
    assert.equal(got.divisionId, expected, `${text} -> ${got.divisionId}`);
  }
});

test('refuses to guess when nothing matches', () => {
  const got = classify('Hello, I would like some general information please.');
  assert.equal(got.divisionId, null);
  assert.equal(got.needsConfirmation, true);
  assert.equal(got.confidence, 0);
  assert.equal(got.method, 'no-lexicon-match');
});

test('flags low-confidence routing for confirmation', () => {
  // A single supporting-weight word should not produce a confident route.
  const got = classify('road');
  if (got.divisionId) {
    assert.ok(got.confidence < 0.55, `expected low confidence, got ${got.confidence}`);
    assert.equal(got.needsConfirmation, true);
  }
});

test('detects urgency without letting it change routing', () => {
  const got = classify('I received a death threat and a bomb threat over a fake website otp fraud');
  assert.equal(got.urgent, true);
  assert.ok(got.urgentTerms.length > 0);
  // Urgency must not hijack the division.
  assert.ok(got.divisionId !== null);
});

test('a citizen overriding the route always wins', () => {
  const got = classify('otp upi fraud debited', { preferDivision: 'judicial' });
  assert.equal(got.divisionId, 'judicial');
  assert.equal(got.confidence, 1);
  assert.equal(got.method, 'citizen-selected');
  assert.equal(got.needsConfirmation, false);
});

test('matches inflected forms, not just dictionary forms', () => {
  /*
   * Indic suffixation replaces a word-final virama with the suffix's vowel
   * sign, so the bare term stops being a substring of the inflected word.
   * These are the forms a citizen actually writes - "in the cyclone", not
   * "cyclone" - and each one previously failed to match.
   */
  const inflected = [
    // Tamil: புயல் (cyclone) -> புயலில் (in the cyclone)
    ['disaster', 'புயலில் எங்கள் வீடு இடிந்து விழுந்தது, நிவாரணமும் கிடைக்கவில்லை'],
    // Hindi: बम (bomb) -> बमों (bombs, oblique)
    ['counter_terror', 'आतंकवादियों ने बमों की धमकी दी है'],
    // Malayalam: ബാങ്ക് -> ബാങ്കിൽ (in the bank)
    ['cyber', 'എന്റെ ബാങ്കിൽ നിന്ന് സൈബർ തട്ടിപ്പിലൂടെ പണം പോയി'],
    // Kannada: ಬ್ಯಾಂಕ್ -> ಬ್ಯಾಂಕಿನಿಂದ (from the bank)
    ['cyber', 'ನನ್ನ ಬ್ಯಾಂಕಿನಿಂದ ಸೈಬರ್ ವಂಚನೆಯಿಂದ ಹಣ ಹೋಗಿದೆ'],
  ];

  const failures = [];
  for (const [expected, text] of inflected) {
    const got = classify(text);
    if (got.divisionId !== expected) failures.push(`"${text.slice(0, 40)}" -> ${got.divisionId}`);
  }
  assert.deepEqual(failures, [], `inflected forms missed:\n${failures.join('\n')}`);
});

test('word boundaries are respected for Latin terms', () => {
  // "otp" must not fire inside "adopted", "ngo" not inside "among".
  const got = classify('The child was adopted among several families');
  assert.equal(got.divisionId, null, `false positive: ${JSON.stringify(got.matched)}`);
});
