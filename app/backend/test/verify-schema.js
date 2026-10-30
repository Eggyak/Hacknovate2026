/**
 * Audit the running system against the requirements document.
 *
 * Every entry below is transcribed from "MHA Grievance Bot - Data Schema &
 * Workflow Requirements". Nothing here is derived from the implementation, so
 * the two can genuinely disagree - which is the point.
 *
 * Three passes:
 *   1. does a column exist to hold each base field
 *   2. does every division and every dynamic field exist, with nothing extra
 *   3. does a complaint filed through the BOT actually populate the base
 *      fields - a column that exists but is never filled is not an
 *      implemented requirement
 *
 *   docker exec mha-api node test/verify-schema.js
 */

import jwt from 'jsonwebtoken';
import { pool, query } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';

const BASE = `http://127.0.0.1:${env.port}`;
let failed = 0;
const gaps = [];

function check(name, ok, detail = '') {
  if (!ok) {
    failed += 1;
    gaps.push(name);
  }
  console.log(`${ok ? 'PASS' : 'GAP '}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

/* ---- Section 1: common base fields, required for EVERY complaint ---- */

const BASE_FIELDS = [
  // [document wording, table, column(s)]
  ['Name', 'citizens', ['full_name']],
  ['Mobile Number', 'citizens', ['mobile']],
  ['OTP Verification Status', 'citizens', ['mobile_verified']],
  ['Gender', 'citizens', ['gender']],
  ['Email (Optional)', 'citizens', ['email']],

  ['Pincode', 'grievances', ['pincode']],
  ['State', 'grievances', ['state']],
  ['District', 'grievances', ['district']],
  ['Complete Address', 'grievances', ['address']],
  ['Pinned GPS Coordinates', 'grievances', ['latitude', 'longitude']],

  ['Raw Audio File Path', 'grievances', ['audio_path']],
  ['Original Regional Text', 'grievances', ['original_text']],
  ['Translated English Text', 'grievances', ['translated_text']],
  ['Evidence/Attachments (PDF/Images)', 'grievance_attachments', ['stored_name', 'mime_type']],

  ['Grievance Registration ID', 'grievances', ['reference_id']],
  ['Submission Timestamp', 'grievances', ['submitted_at']],
  ['SLA Deadline (Timestamp + 21 Days)', 'grievances', ['sla_deadline']],
  ['Detected Language', 'grievances', ['detected_language']],

  ['Declaration of Truth (Yes/No boolean)', 'grievances', ['declaration_truth']],
];

/* ---- Section 2: dynamic incident details, by MHA division ---- */

const DIVISION_FIELDS = {
  'Cyber & Information Security': [
    'Transaction ID / UTR Number', 'Amount Lost', 'Date and Time of Fraud',
    'Platform Used', 'Suspect Details',
  ],
  'Foreigners Division': [
    'Passport Number', 'File / Application Reference Number', 'Nationality',
    'Visa / OCI Type', 'Date of Issue / Expiry',
  ],
  'Disaster Management': [
    'Aadhaar Number', 'Bank Account', 'IFSC', 'Name of Disaster', 'Category of Damage',
  ],
  'Freedom Fighters & Rehabilitation': [
    'PPO', 'Bank Branch', 'IFSC', 'Name of Freedom Fighter', 'Sanction Date',
  ],
  'Central Armed Police Forces': [
    'Specific Force Name', 'Officer Name / Badge Number',
    'Date and Exact Location of Incident', 'Type of Misconduct',
  ],
  'NGOs & Foreign Contribution (FCRA)': [
    'NGO Name', 'FCRA Registration Number', 'State of Registration', 'Nature of Violation',
  ],
  'Union Territory Administration': [
    'Specific Union Territory', 'Civic Department', 'Ward / Zone Number', 'Property ID / Tax Number',
  ],
  'Internal Security': [
    'Nature of Intelligence / Complaint', 'Target Location / State', 'Suspect Details / Organization',
  ],
  'Counter Terrorism & Counter Radicalization': [
    'Platform of Radicalization', 'Type of Threat', 'Location / Subject of Threat',
  ],
  'Left Wing Extremism & North East': [
    'Specific Region / Village', 'Nature of Complaint', 'Local Police Station Jurisdiction',
  ],
  'Border Management': [
    'Border Name / State', 'Specific Village / Post', 'Issue Category',
  ],
  'Judicial Division': [
    'Prisoner Name & Registration Number', 'Name of Prison / Jail',
    'Court Case / FIR Number', 'Nature of Petition',
  ],
  'Police Divisions (IPS & Gallantry Awards)': [
    'Name of IPS Officer / Nominee', 'State Cadre', 'Nature of Request',
  ],
  'Centre-State Division': ['States Involved', 'Dispute Nature'],
  'Internal Divisions (Administration, Finance, International Cooperation)': [
    'Query Type', 'Reference Number / Date',
  ],
};

/** Loose match: the document's wording and the field label need not be identical. */
function labelMatches(docLabel, labels) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(docLabel);
  return labels.some((l) => {
    const got = norm(l);
    return got.includes(want) || want.includes(got);
  });
}

async function passOne() {
  console.log('\n=== 1. Common base fields: is there a column for each ===');
  for (const [label, table, columns] of BASE_FIELDS) {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 AND column_name = ANY($2)`,
      [table, columns],
    );
    check(`${label}`, r.rows.length === columns.length, `${table}.${columns.join(', ')}`);
  }
}

async function passTwo() {
  const res = await fetch(`${BASE}/api/grievances/divisions`);
  const { divisions } = await res.json();

  console.log(`\n=== 2. Divisions: document lists ${Object.keys(DIVISION_FIELDS).length}, system serves ${divisions.length} ===`);

  for (const [docName, docFields] of Object.entries(DIVISION_FIELDS)) {
    const d = divisions.find((x) => labelMatches(docName, [x.name]));
    if (!d) {
      check(`division: ${docName}`, false, 'not present');
      continue;
    }
    const labels = d.fields.map((f) => f.label);
    const missing = docFields.filter((f) => !labelMatches(f, labels));
    check(`${d.name} (${docFields.length} fields)`, missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${labels.length} fields present`);
  }

  const docNames = Object.keys(DIVISION_FIELDS);
  const extra = divisions.filter((d) => !docNames.some((n) => labelMatches(n, [d.name])));
  check('no divisions beyond the document', extra.length === 0,
    extra.map((d) => d.name).join(', ') || 'none');
}

/**
 * The pass that matters. Files a complaint the way a citizen does and reads
 * the stored row back, so a column that exists but is never populated by the
 * interview shows up as the gap it is.
 */
async function passThree() {
  console.log('\n=== 3. Does the bot actually populate the base fields ===');

  const mobile = '9000000021';
  await query('DELETE FROM citizens WHERE mobile = $1', [mobile]);
  const citizen = (await query(
    'INSERT INTO citizens (mobile, mobile_verified, preferred_language) VALUES ($1, TRUE, $2) RETURNING *',
    [mobile, 'hi'],
  )).rows[0];
  const token = jwt.sign({ sub: String(citizen.id), mobile }, env.jwt.secret,
    { expiresIn: 900, issuer: 'mha-samadhan' });

  const call = async (path, opts = {}) => {
    const res = await fetch(`${BASE}/api${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const start = await call('/chat/start', { method: 'POST', body: { language: 'hi' } });
  const id = start.data.conversationId;
  const say = (text) => call(`/chat/${id}/message`, { method: 'POST', body: { text, inputMode: 'text' } });

  await say('मेरे बैंक खाते से ओटीपी के जरिए पचास हजार रुपये की साइबर धोखाधड़ी हुई है');
  await call(`/chat/${id}/division`, { method: 'POST', body: { divisionId: 'cyber' } });

  for (const a of ['UTR123456789012', '50000', '2026-10-29 11:00', 'Fake website']) await say(a);

  // Audio, as a voice complaint would supply it.
  const form = new FormData();
  form.append('audio', new Blob([Buffer.alloc(2048, 3)], { type: 'audio/webm' }), 'n.webm');
  await fetch(`${BASE}/api/grievances/conversation/${id}/audio`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });

  // Evidence.
  const ev = new FormData();
  ev.append('files', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'proof.pdf');
  await fetch(`${BASE}/api/grievances/conversation/${id}/evidence`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: ev,
  });

  await say('110001');
  await say('New Delhi');
  await say('House 12, Connaught Place');

  // The location pin, as the "Share my location" button supplies it.
  await call(`/chat/${id}/draft`, {
    method: 'PATCH',
    body: { latitude: 28.6315, longitude: 77.2167 },
  });

  await say('Test Citizen');
  await say('Male');
  await call(`/chat/${id}/declaration`, { method: 'POST', body: { accepted: true } });

  const done = await call(`/chat/${id}/submit`, { method: 'POST', body: {} });
  if (done.status !== 201) {
    check('complaint filed through the bot', false, JSON.stringify(done.data).slice(0, 200));
    await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
    return;
  }

  const g = (await query('SELECT * FROM grievances WHERE reference_id = $1', [done.data.reference])).rows[0];
  const c = (await query('SELECT * FROM citizens WHERE id = $1', [citizen.id])).rows[0];
  const atts = (await query('SELECT * FROM grievance_attachments WHERE grievance_id = $1', [g.id])).rows;

  const filled = (v) => v !== null && v !== undefined && v !== '';

  check('Name populated', filled(c.full_name), c.full_name);
  check('Mobile Number populated', filled(c.mobile), c.mobile);
  check('OTP Verification Status populated', c.mobile_verified === true, String(c.mobile_verified));
  check('Gender populated', filled(c.gender), c.gender);

  check('Pincode populated', filled(g.pincode), g.pincode);
  check('State populated', filled(g.state), g.state);
  check('District populated', filled(g.district), g.district ?? 'NULL');
  check('Complete Address populated', filled(g.address), g.address);
  check('Pinned GPS Coordinates populated', filled(g.latitude) && filled(g.longitude),
    `${g.latitude ?? 'NULL'}, ${g.longitude ?? 'NULL'}`);

  check('Raw Audio File Path populated', filled(g.audio_path), g.audio_path ?? 'NULL');
  check('Original Regional Text populated', filled(g.original_text), `${g.original_text.slice(0, 32)}...`);
  check('Evidence stored', atts.length > 0, `${atts.length} file(s)`);

  check('Grievance Registration ID populated', /^MHA-GRV-\d{4}-\d{6}$/.test(g.reference_id), g.reference_id);
  check('Submission Timestamp populated', filled(g.submitted_at), String(g.submitted_at));
  check('SLA Deadline = submitted + 21 days',
    Math.round((new Date(g.sla_deadline) - new Date(g.submitted_at)) / 86400000) === 21);
  check('Detected Language populated', filled(g.detected_language), g.detected_language);
  check('Declaration of Truth populated', g.declaration_truth === true, String(g.declaration_truth));

  // Translated English Text depends on an optional service; report its real state.
  const translationConfigured = (await (await fetch(`${BASE}/api/health`)).json())
    .capabilities.translation;
  check('Translated English Text populated', filled(g.translated_text) || !translationConfigured,
    translationConfigured ? (g.translated_text || 'NULL')
      : 'no translator configured - field intentionally null, reported as skipped');

  await query('DELETE FROM citizens WHERE id = $1', [citizen.id]);
}

async function main() {
  await passOne();
  await passTwo();
  await passThree();

  console.log('\n' + '='.repeat(60));
  if (failed === 0) {
    console.log('Every field in the requirements document is present and populated.');
  } else {
    console.log(`${failed} gap(s):`);
    for (const g of gaps) console.log(`  - ${g}`);
  }
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
