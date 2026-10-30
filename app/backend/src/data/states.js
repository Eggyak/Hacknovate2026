/**
 * States, union territories, and the languages actually spoken in each.
 *
 * Used for two different jobs:
 *
 *   1. Deriving State from a PIN code, so the citizen does not have to type
 *      what the first two digits of their own PIN already say.
 *
 *   2. Narrowing the Azure language-identification candidate set. Azure
 *      evaluates at most 10 candidate locales per utterance and we support 14,
 *      so `languages` here decides which four get dropped for a given citizen.
 *      Someone filing from a 68xxxx PIN gets Malayalam in the running; someone
 *      filing from 78xxxx gets Assamese.
 *
 * PIN prefixes are the first TWO digits of the 6-digit code. A handful of
 * states share a prefix band with a neighbour; where that happens the more
 * populous claimant owns the prefix and `ambiguousPrefixes` records the rest so
 * the UI can still offer a correction instead of silently guessing.
 */

export const STATES = [
  { code: 'DL', name: 'Delhi', ut: true, pins: ['11'], languages: ['hi', 'ur', 'pa', 'en'] },
  { code: 'HR', name: 'Haryana', pins: ['12', '13'], languages: ['hi', 'pa', 'ur'] },
  { code: 'PB', name: 'Punjab', pins: ['14', '15'], languages: ['pa', 'hi', 'ur'] },
  { code: 'CH', name: 'Chandigarh', ut: true, pins: ['16'], languages: ['pa', 'hi', 'en'] },
  { code: 'HP', name: 'Himachal Pradesh', pins: ['17'], languages: ['hi', 'pa'] },
  { code: 'JK', name: 'Jammu & Kashmir', ut: true, pins: ['18', '19'], languages: ['ur', 'hi', 'pa'] },
  { code: 'UP', name: 'Uttar Pradesh', pins: ['20', '21', '22', '23', '26', '27', '28'], languages: ['hi', 'ur', 'ne'] },
  { code: 'UK', name: 'Uttarakhand', pins: ['24', '25'], languages: ['hi', 'ne', 'ur'] },
  { code: 'RJ', name: 'Rajasthan', pins: ['30', '31', '32', '33', '34'], languages: ['hi', 'ur', 'gu'] },
  { code: 'GJ', name: 'Gujarat', pins: ['36', '37', '38', '39'], languages: ['gu', 'hi', 'ur', 'mr'] },
  { code: 'MH', name: 'Maharashtra', pins: ['40', '41', '42', '43', '44'], languages: ['mr', 'hi', 'ur', 'gu'] },
  { code: 'MP', name: 'Madhya Pradesh', pins: ['45', '46', '47', '48'], languages: ['hi', 'mr', 'ur'] },
  { code: 'CG', name: 'Chhattisgarh', pins: ['49'], languages: ['hi', 'or', 'mr'] },
  { code: 'TG', name: 'Telangana', pins: ['50'], languages: ['te', 'ur', 'hi', 'kn', 'mr'] },
  { code: 'AP', name: 'Andhra Pradesh', pins: ['51', '52', '53'], languages: ['te', 'ur', 'hi', 'ta', 'kn'] },
  { code: 'KA', name: 'Karnataka', pins: ['56', '57', '58', '59'], languages: ['kn', 'ur', 'te', 'ta', 'mr', 'ml'] },
  { code: 'TN', name: 'Tamil Nadu', pins: ['60', '61', '62', '63', '64'], languages: ['ta', 'te', 'kn', 'ml', 'ur'] },
  { code: 'PY', name: 'Puducherry', ut: true, pins: ['605', '607', '609'], languages: ['ta', 'ml', 'te'] },
  { code: 'KL', name: 'Kerala', pins: ['67', '68', '69'], languages: ['ml', 'ta', 'kn'] },
  { code: 'LD', name: 'Lakshadweep', ut: true, pins: ['682'], languages: ['ml'] },
  { code: 'WB', name: 'West Bengal', pins: ['70', '71', '72', '73', '74'], languages: ['bn', 'hi', 'ur', 'ne', 'as'] },
  { code: 'AN', name: 'Andaman & Nicobar Islands', ut: true, pins: ['744'], languages: ['bn', 'hi', 'ta', 'te'] },
  { code: 'OR', name: 'Odisha', pins: ['75', '76', '77'], languages: ['or', 'hi', 'te', 'bn'] },
  { code: 'AS', name: 'Assam', pins: ['78'], languages: ['as', 'bn', 'hi', 'ne'] },
  { code: 'NE', name: 'North Eastern States', pins: ['79'], languages: ['as', 'bn', 'ne', 'hi'] },
  { code: 'BR', name: 'Bihar', pins: ['80', '81', '84', '85'], languages: ['hi', 'ur', 'bn', 'ne'] },
  { code: 'JH', name: 'Jharkhand', pins: ['82', '83'], languages: ['hi', 'ur', 'bn', 'or'] },
];

/** Prefixes where more than one state is a legitimate answer. */
export const AMBIGUOUS_PREFIXES = {
  '79': ['Arunachal Pradesh', 'Nagaland', 'Manipur', 'Mizoram', 'Tripura', 'Meghalaya'],
};

const BY_PREFIX = new Map();
for (const s of STATES) {
  for (const p of s.pins) {
    // Longer prefixes win, so 682 (Lakshadweep) beats 68 (Kerala).
    const existing = BY_PREFIX.get(p);
    if (!existing || p.length > existing.matched.length) {
      BY_PREFIX.set(p, { ...s, matched: p });
    }
  }
}

export const BY_CODE = new Map(STATES.map((s) => [s.code, s]));

/**
 * Resolve a 6-digit PIN to a state. Checks the 3-digit prefix before the
 * 2-digit one so island and enclave PINs are not swallowed by their larger
 * neighbour. Returns null for anything that is not a plausible Indian PIN.
 */
export function stateForPincode(pincode) {
  const pin = String(pincode || '').trim();
  if (!/^[1-9][0-9]{5}$/.test(pin)) return null;
  return BY_PREFIX.get(pin.slice(0, 3)) || BY_PREFIX.get(pin.slice(0, 2)) || null;
}

/** Language codes plausible for a PIN code, best-first. Empty when unknown. */
export function languagesForPincode(pincode) {
  const state = stateForPincode(pincode);
  return state ? state.languages : [];
}

export function isValidPincode(pincode) {
  return /^[1-9][0-9]{5}$/.test(String(pincode || '').trim());
}
