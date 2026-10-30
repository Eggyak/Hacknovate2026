import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage } from '../src/services/languageDetect.js';

/**
 * Real complaint sentences, one per supported language. These are the kind of
 * thing a citizen actually types into a grievance box, not dictionary samples.
 */
const SAMPLES = [
  ['en', 'Money was fraudulently debited from my bank account yesterday.'],
  ['hi', 'मेरे बैंक खाते से कल पचास हजार रुपये की धोखाधड़ी हुई है, कृपया मेरी शिकायत दर्ज करें।'],
  ['mr', 'माझ्या बँक खात्यातून पन्नास हजार रुपये काढले आहेत, कृपया माझी तक्रार नोंदवा.'],
  ['ne', 'मेरो बैंक खाताबाट पैसा निकालिएको छ, कृपया मेरो उजुरी दर्ता गर्नुहोस्।'],
  ['bn', 'আমার ব্যাংক অ্যাকাউন্ট থেকে টাকা তোলা হয়েছে, দয়া করে আমার অভিযোগ নথিভুক্ত করুন।'],
  ['as', 'মোৰ বেংক একাউণ্টৰ পৰা টকা উলিওৱা হৈছে, অনুগ্ৰহ কৰি মোৰ অভিযোগ পঞ্জীয়ন কৰক।'],
  ['ta', 'எனது வங்கிக் கணக்கிலிருந்து பணம் மோசடியாக எடுக்கப்பட்டது, தயவுசெய்து எனது புகாரைப் பதிவு செய்யுங்கள்.'],
  ['te', 'నా బ్యాంక్ ఖాతా నుండి డబ్బు మోసపూరితంగా తీసివేయబడింది, దయచేసి నా ఫిర్యాదును నమోదు చేయండి.'],
  ['kn', 'ನನ್ನ ಬ್ಯಾಂಕ್ ಖಾತೆಯಿಂದ ಹಣವನ್ನು ವಂಚನೆಯಿಂದ ತೆಗೆಯಲಾಗಿದೆ, ದಯವಿಟ್ಟು ನನ್ನ ದೂರನ್ನು ದಾಖಲಿಸಿ.'],
  ['ml', 'എന്റെ ബാങ്ക് അക്കൗണ്ടിൽ നിന്ന് പണം തട്ടിപ്പിലൂടെ എടുത്തു, ദയവായി എന്റെ പരാതി രജിസ്റ്റർ ചെയ്യുക.'],
  ['gu', 'મારા બેંક ખાતામાંથી છેતરપિંડીથી પૈસા ઉપાડી લેવાયા છે, કૃપા કરીને મારી ફરિયાદ નોંધો.'],
  ['pa', 'ਮੇਰੇ ਬੈਂਕ ਖਾਤੇ ਵਿੱਚੋਂ ਧੋਖੇ ਨਾਲ ਪੈਸੇ ਕੱਢ ਲਏ ਗਏ ਹਨ, ਕਿਰਪਾ ਕਰਕੇ ਮੇਰੀ ਸ਼ਿਕਾਇਤ ਦਰਜ ਕਰੋ।'],
  ['or', 'ମୋର ବ୍ୟାଙ୍କ ଖାତାରୁ ଠକେଇ କରି ଟଙ୍କା ନିଆଯାଇଛି, ଦୟାକରି ମୋର ଅଭିଯୋଗ ପଞ୍ଜିକରଣ କରନ୍ତୁ।'],
  ['ur', 'میرے بینک اکاؤنٹ سے دھوکہ دہی سے پیسے نکال لیے گئے ہیں، براہ کرم میری شکایت درج کریں۔'],
];

test('identifies all 14 supported languages from typed text', () => {
  const failures = [];
  for (const [expected, text] of SAMPLES) {
    const got = detectLanguage(text);
    if (got.code !== expected) {
      failures.push(`${expected}: got ${got.code} (${got.method}, conf ${got.confidence})`);
    }
  }
  assert.deepEqual(failures, [], `misidentified:\n${failures.join('\n')}`);
});

test('reports usable confidence on full sentences', () => {
  for (const [expected, text] of SAMPLES) {
    const got = detectLanguage(text);
    assert.ok(got.confidence >= 0.5, `${expected} confidence too low: ${got.confidence}`);
  }
});

test('always explains itself', () => {
  for (const [, text] of SAMPLES) {
    const got = detectLanguage(text);
    assert.ok(Array.isArray(got.evidence) && got.evidence.length > 0, 'evidence missing');
    assert.ok(got.method, 'method missing');
  }
});

test('Assamese is separated from Bengali by its exclusive letters', () => {
  const as = detectLanguage('মোৰ অভিযোগ পঞ্জীয়ন কৰক');
  assert.equal(as.code, 'as');
  assert.equal(as.method, 'assamese-exclusive-letter');

  const bn = detectLanguage('আমার অভিযোগ নথিভুক্ত করুন এবং আমাকে জানান');
  assert.equal(bn.code, 'bn');
});

test('Devanagari trio is separated by marker words', () => {
  assert.equal(detectLanguage('यह काम नहीं हुआ है और मेरा पैसा गया').code, 'hi');
  assert.equal(detectLanguage('हे काम झाले नाही आणि माझे पैसे गेले आहेत').code, 'mr');
  assert.equal(detectLanguage('यो काम भएको छैन र मेरो पैसा गयो छ').code, 'ne');
});

test('degrades honestly instead of guessing', () => {
  const empty = detectLanguage('');
  assert.equal(empty.confidence, 0);
  assert.equal(empty.method, 'empty-input');

  const digits = detectLanguage('123456 !!! ???');
  assert.equal(digits.confidence, 0);
  assert.equal(digits.method, 'no-letters');

  // Bare Devanagari with no markers should be low-confidence, not confident.
  const bare = detectLanguage('शिकायत');
  assert.ok(bare.confidence < 0.5, `expected low confidence, got ${bare.confidence}`);
});

test('honours a stated language when the script is ambiguous and silent', () => {
  const got = detectLanguage('शिकायत', { hint: 'mr' });
  assert.equal(got.code, 'mr');
  assert.equal(got.method, 'script-plus-stated-language');
});

test('short, language-neutral input reports little evidence', () => {
  /*
   * These are form answers, not language samples. They must not look
   * confident enough to redirect a conversation someone is mid-way through.
   */
  for (const neutral of ['UTR123456789012', 'Male', 'SBIN0001234', '50000', '110001']) {
    const got = detectLanguage(neutral);
    assert.ok((got.letters || 0) < 8, `${neutral} reported ${got.letters} letters`);
  }

  // A real sentence, by contrast, has plenty.
  const real = detectLanguage('Money was fraudulently taken from my bank account');
  assert.ok(real.letters >= 8 && real.confidence >= 0.9, JSON.stringify(real));
});
