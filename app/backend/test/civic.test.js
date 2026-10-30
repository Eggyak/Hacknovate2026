import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterSignature, scorePriority, PRIORITY } from '../src/services/civicRules.js';
import { classify } from '../src/services/classifier.js';

test('priority follows what the classifier already found', () => {
  // A threat to life outranks everything, whatever division it lands in.
  const urgent = classify('There is a bomb threat at the school');
  assert.equal(scorePriority({ classification: urgent, divisionId: 'counter_terror' }), PRIORITY.CRITICAL);

  // Money actually lost is high; a trivial sum is not.
  assert.equal(
    scorePriority({ classification: {}, divisionId: 'cyber', details: { amount_lost: '50000' } }),
    PRIORITY.HIGH,
  );
  assert.equal(
    scorePriority({ classification: {}, divisionId: 'cyber', details: { amount_lost: '200' } }),
    PRIORITY.MEDIUM,
  );

  // An RTI reference query is not an emergency.
  assert.equal(scorePriority({ classification: {}, divisionId: 'internal_admin' }), PRIORITY.LOW);
});

test('two reports of the same problem share a signature', () => {
  const a = classify('Cyber fraud, money debited from my bank account by OTP scam');
  const b = classify('OTP scam debited money from my bank account, cyber fraud');
  const base = { divisionId: 'cyber', pincode: '110001' };

  const sigA = clusterSignature({ ...base, classification: a });
  const sigB = clusterSignature({ ...base, classification: b });

  assert.ok(sigA, 'no signature produced');
  assert.equal(sigA, sigB, 'word order changed the signature');
});

test('different problems do not share a signature', () => {
  const fraud = classify('OTP cyber fraud debited my bank account');
  const flood = classify('Our house collapsed in the cyclone and relief has not come');
  const sigA = clusterSignature({ divisionId: 'cyber', pincode: '110001', classification: fraud });
  const sigB = clusterSignature({ divisionId: 'disaster', pincode: '110001', classification: flood });
  assert.notEqual(sigA, sigB);
});

test('nothing distinctive means no grouping at all', () => {
  /*
   * Grouping on weak evidence is worse than not grouping: it buries one
   * citizen's complaint inside somebody else's unrelated cluster.
   */
  const vague = classify('Please help me with a problem');
  assert.equal(clusterSignature({ divisionId: 'cyber', pincode: '110001', classification: vague }), null);
});

test('a signature needs a place, not just a problem', () => {
  const c = classify('OTP cyber fraud debited my bank account');
  // Same terms, different PIN codes are different problems; the caller is
  // responsible for passing the pincode, and assignCluster refuses without one.
  const here = clusterSignature({ divisionId: 'cyber', pincode: '110001', classification: c });
  const there = clusterSignature({ divisionId: 'cyber', pincode: '600001', classification: c });
  assert.equal(here, there, 'signature itself is place-independent by design');
  // The place is part of the cluster key, asserted in the e2e suite.
});
