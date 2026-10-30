import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const password = 'Scenario-Test-Password-2026';
const departments = [
  { id: 'CYBER_INFORMATION_SECURITY', category: 'CYBERCRIME', details: { transactionId: 'SYN-UTR-0001', amountLost: 1250, fraudDateTime: '2026-01-02T10:20:00Z', platformUsed: 'Synthetic UPI portal', suspectDetails: 'synthetic@upi / +91 90000 00001' } },
  { id: 'FOREIGNERS', category: 'IMMIGRATION', details: { passportNumber: 'SYN-PASS-0002', applicationReferenceNumber: 'SYN-VISA-0002', nationality: 'Synthetic', visaType: 'Student', issueDate: '2025-01-01', expiryDate: '2027-01-01' } },
  { id: 'DISASTER_MANAGEMENT', category: 'DISASTER_RELIEF', details: { aadhaarNumber: '000000000000', bankAccountDetails: { accountNumber: '000000000000', ifsc: 'SYNTH000001' }, disasterName: 'Synthetic Flood', damageCategory: 'House damage' } },
  { id: 'UT_ADMINISTRATION', category: 'UT_ADMIN', details: { specificUt: 'Synthetic UT', civicDepartment: 'Water Board', wardOrZoneNumber: 'SYN-WARD-03', propertyId: 'SYN-PROPERTY-0004' } },
  { id: 'FREEDOM_FIGHTERS_REHABILITATION', category: 'FREEDOM_FIGHTERS_REHABILITATION', details: { ppoNumber: 'SYN-PPO-0005', bankBranch: 'Synthetic branch', ifsc: 'SYNTH000005', freedomFighterName: 'Synthetic Beneficiary', sanctionDate: '2024-01-01' } },
  { id: 'CENTRAL_ARMED_POLICE_FORCES', category: 'CAPF_MISCONDUCT', details: { forceName: 'Synthetic CAPF', officerName: 'Synthetic Officer', badgeNumber: 'SYN-06', incidentDate: '2026-01-05', incidentLocation: 'Synthetic Checkpost', misconductType: 'Synthetic allegation' } },
  { id: 'NGO_FCRA', category: 'FCRA_NGO', details: { ngoName: 'Synthetic NGO', fcraRegistrationNumber: 'SYN-FCRA-0007', registrationState: 'Synthetic State', violationNature: 'Synthetic report' } },
  { id: 'INTERNAL_SECURITY', category: 'INTERNAL_SECURITY', details: { complaintNature: 'Synthetic internal security tip', targetLocation: 'Synthetic location', suspectOrOrganization: 'Synthetic organization' } },
  { id: 'COUNTER_TERRORISM', category: 'COUNTER_TERRORISM', details: { radicalizationPlatform: 'Synthetic platform', threatType: 'Synthetic tip', threatLocationOrSubject: 'Synthetic subject' } },
  { id: 'LWE_NORTH_EAST', category: 'LWE_NORTH_EAST', details: { regionOrVillage: 'Synthetic village', complaintNature: 'Synthetic report', policeStationJurisdiction: 'Synthetic station' } },
  { id: 'BORDER_MANAGEMENT', category: 'BORDER_MANAGEMENT', details: { borderNameOrState: 'Synthetic border', villageOrPost: 'Synthetic post', issueCategory: 'Synthetic issue' } },
  { id: 'JUDICIAL', category: 'JUDICIAL', details: { prisonerName: 'Synthetic person', prisonerRegistrationNumber: 'SYN-REG-0012', prisonName: 'Synthetic facility', courtCaseOrFirNumber: 'SYN-CASE-0012', petitionNature: 'Synthetic petition' } },
  { id: 'POLICE', category: 'POLICE', details: { officerOrNomineeName: 'Synthetic officer', stateCadre: 'Synthetic cadre', requestNature: 'Synthetic request' } },
  { id: 'CENTRE_STATE', category: 'CENTRE_STATE', details: { statesInvolved: ['Synthetic State A', 'Synthetic State B'], disputeNature: 'Synthetic coordination issue' } },
  { id: 'INTERNAL_ADMINISTRATION', category: 'INTERNAL_DIVISIONS', details: { queryType: 'Synthetic query', referenceNumberOrDate: 'SYN-REF-0015' } },
  { id: 'OTHER_TRIAGE', category: 'OTHER', details: { passportNumber: 'SYN-SECRET-MUST-BE-DROPPED', arbitrarySensitiveValue: 'SYN-SECRET' } },
];

let workDir;
let databasePath;
let apiPort;
let apiBase;
let apiProcess;
let database;
let adminToken;
let ticketsByDivision = new Map();
let accounts = new Map();

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function waitForApi() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) throw new Error(`Test API exited early with code ${apiProcess.exitCode}.`);
    try {
      const result = await request('/api/health');
      if (result.status === 200) return;
    } catch { /* Wait for the isolated API to finish starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the isolated scenario API.');
}

async function login(email, suppliedPassword = password) {
  const result = await request('/api/auth/login', { method: 'POST', body: { email, password: suppliedPassword } });
  assert.equal(result.status, 200, `Login failed for ${email}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function createScenarioAccount(id, roleId, wards = []) {
  const name = `SYNTHETIC ${id}`;
  database.prepare(`INSERT INTO users(id,name,email,mobile_number,password_hash,role_id,assigned_wards_json,is_active,avatar_initials,must_change_password)
    VALUES(?,?,?,?,?,?,?,?,?,0)`).run(id, name, `${id.toLowerCase()}@scenario.invalid`, '+91 90000 00000', bcrypt.hashSync(password, 4), roleId, JSON.stringify(wards), 1, 'ST');
  accounts.set(id, `${id.toLowerCase()}@scenario.invalid`);
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'mha-rbac-scenarios-'));
  databasePath = join(workDir, 'scenario.sqlite');
  apiPort = await freePort();
  apiBase = `http://127.0.0.1:${apiPort}`;
  apiProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(apiPort), MHA_DATABASE_PATH: databasePath, NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  await waitForApi();
  database = new Database(databasePath);

  const setup = await request('/api/auth/initial-admin', { method: 'POST', body: { name: 'Synthetic Staff Admin', email: 'staff-admin@scenario.invalid', mobileNumber: '+91 90000 00000', password } });
  assert.equal(setup.status, 201);
  adminToken = (await login('staff-admin@scenario.invalid')).token;

  const roleRows = database.prepare('SELECT id,scope_type,division_id,access_level,permissions_json FROM roles ORDER BY id').all();
  const roleById = new Map(roleRows.map((role) => [role.id, role]));
  for (const department of departments.filter((entry) => entry.id !== 'OTHER_TRIAGE')) {
    assert.ok(roleById.has(`ROLE-${department.id}`), `Missing Division Admin role for ${department.id}`);
    assert.ok(roleById.has(`ROLE-L1-${department.id}`), `Missing L1 role for ${department.id}`);
    assert.ok(roleById.has(`ROLE-APPEAL-${department.id}`), `Missing Appellate role for ${department.id}`);
  }
  assert.equal(roleById.get('ROLE-OTHER-CASE-TRIAGE')?.division_id, 'OTHER_TRIAGE');

  const wardRows = database.prepare('SELECT id,pincode_prefix,state,district,name FROM wards ORDER BY id').all();
  const createTicket = async (department, wardId, suffix) => {
    const ward = wardRows.find((row) => row.id === wardId);
    const intake = await request('/api/intake/grievances', { method: 'POST', body: {
      complainantName: `[SYNTHETIC TEST] ${department.id} ${suffix}`,
      mobileNumber: `+91 90000 000${String(suffix).padStart(2, '0')}`,
      wardId,
      category: department.category,
      divisionId: department.id,
      detectedLanguage: 'Hindi',
      originalRegionalText: `[SYNTHETIC TEST RECORD — NOT A REAL CITIZEN] Sample ${department.category} complaint ${suffix}.`,
      translatedEnglishText: `[SYNTHETIC TEST RECORD — NOT A REAL CITIZEN] Translated case ${suffix}.`,
      location: { state: ward.state, district: ward.district, pincode: ward.pincode_prefix, completeAddress: `${ward.name}, ${ward.district}`, coordinates: { latitude: 0, longitude: 0 } },
      details: department.details,
      evidence: [{ id: `SYN-EVIDENCE-${suffix}`, fileName: 'synthetic-note.txt', mimeType: 'text/plain', url: `/synthetic/${suffix}` }],
    } });
    assert.equal(intake.status, 201, `Intake failed for ${department.id}: ${JSON.stringify(intake.data)}`);
    const ticket = intake.data.ticket;
    ticketsByDivision.set(`${department.id}:${suffix}`, ticket.id);
    if (department.id !== 'OTHER_TRIAGE' && suffix !== 99) {
      const payload = database.prepare('SELECT payload_json FROM tickets WHERE id=?').get(ticket.id);
      database.prepare('UPDATE tickets SET payload_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(payload.payload_json), appealStatus: 'APPEALED' }), ticket.id);
    }
    return ticket;
  };

  for (let index = 0; index < departments.length; index++) await createTicket(departments[index], 'WARD-101', index + 1);
  await createTicket(departments[0], 'WARD-102', 99); // same department, outside WARD-101 assignment

  const seedHash = bcrypt.hashSync(password, 4);
  const insertUser = database.prepare(`INSERT INTO users(id,name,email,mobile_number,password_hash,role_id,assigned_wards_json,is_active,avatar_initials,must_change_password)
    VALUES(?,?,?,?,?,?,?,?,?,0)`);
  const addAccount = (id, roleId, assignedWards = []) => {
    const email = `${id.toLowerCase()}@scenario.invalid`;
    insertUser.run(id, `SYNTHETIC ${id}`, email, '+91 90000 00000', seedHash, roleId, JSON.stringify(assignedWards), 1, 'ST');
    accounts.set(id, email);
  };
  for (const department of departments.filter((entry) => entry.id !== 'OTHER_TRIAGE')) {
    addAccount(`DIV-${department.id}`, `ROLE-${department.id}`);
    addAccount(`L1-${department.id}`, `ROLE-L1-${department.id}`, ['WARD-101']);
    addAccount(`APP-${department.id}`, `ROLE-APPEAL-${department.id}`);
  }
  addAccount('OTHER-TRIAGE', 'ROLE-OTHER-CASE-TRIAGE');
  addAccount('WARD-ONE', 'ROLE-WARD-DESK', ['WARD-101']);
  addAccount('WARD-TWO', 'ROLE-MULTI-WARD', ['WARD-101', 'WARD-102']);

  // Synthetic legacy records exercise fail-closed behavior for a broad global role and a role without ticket-read permission.
  database.prepare(`INSERT INTO roles(id,name,description,permissions_json,scope_type,division_id,ward_ids_json,is_system,access_level)
    VALUES('ROLE-TEST-LEGACY-GLOBAL','Synthetic Legacy Global','Scenario only',?, 'GLOBAL',NULL,'[]',0,'DIVISION_ADMIN')`).run(JSON.stringify(['tickets:read']));
  addAccount('LEGACY-GLOBAL', 'ROLE-TEST-LEGACY-GLOBAL');
  database.prepare(`INSERT INTO roles(id,name,description,permissions_json,scope_type,division_id,ward_ids_json,is_system,access_level)
    VALUES('ROLE-TEST-NO-READ','Synthetic No Read','Scenario only',?, 'DIVISION','CYBER_INFORMATION_SECURITY','[]',0,'DIVISION_ADMIN')`).run(JSON.stringify(['analytics:view']));
  addAccount('NO-READ', 'ROLE-TEST-NO-READ');
});

after(async () => {
  if (apiProcess && apiProcess.exitCode === null) {
    apiProcess.kill('SIGTERM');
    await Promise.race([once(apiProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  database?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('MHA department, hierarchy, permission, and ticket data flows stay in scope', async (t) => {
  await t.test('seeds all department-specific hierarchy roles and synthetic intake scenarios', async () => {
    const roles = database.prepare('SELECT id,access_level,permissions_json FROM roles').all();
    const count = departments.filter((department) => department.id !== 'OTHER_TRIAGE').length;
    assert.equal(roles.filter((role) => role.access_level === 'DIVISION_ADMIN' && role.id.startsWith('ROLE-') && role.id !== 'ROLE-SUPER-ADMIN').length >= count, true);
    assert.equal(roles.filter((role) => role.access_level === 'L1_RESOLVING_OFFICER' && role.id.startsWith('ROLE-L1-')).length, count);
    assert.equal(roles.filter((role) => role.access_level === 'APPELLATE_AUTHORITY' && role.id.startsWith('ROLE-APPEAL-')).length, count);
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM tickets').get().total, departments.length + 1);
    assert.equal((await request('/api/health')).data.database, 'sqlite');
    const mismatchedOther = await request('/api/intake/grievances', { method: 'POST', body: {
      complainantName: '[SYNTHETIC TEST] Invalid department/category pairing', mobileNumber: '+91 90000 00000', wardId: 'WARD-101',
      category: 'OTHER', divisionId: 'CYBER_INFORMATION_SECURITY', originalRegionalText: 'Synthetic invalid pairing', translatedEnglishText: 'Synthetic invalid pairing',
    } });
    assert.equal(mismatchedOther.status, 400);
  });

  await t.test('each Division Admin sees only its department and its department fields', async (t2) => {
    for (const department of departments) await t2.test(department.id, async () => {
      const { token } = await login(accounts.get(department.id === 'OTHER_TRIAGE' ? 'OTHER-TRIAGE' : `DIV-${department.id}`));
      const result = await request('/api/bootstrap', { token });
      assert.equal(result.status, 200);
      assert.ok(result.data.tickets.length >= 1);
      assert.ok(result.data.tickets.every((ticket) => ticket.divisionId === department.id));
      const casefile = result.data.tickets.find((ticket) => ticket.category === department.category);
      assert.ok(casefile, `Expected a ${department.category} fixture for ${department.id}`);
      assert.ok(casefile.details && Object.keys(casefile.details).length > 0 || department.id === 'OTHER_TRIAGE');
      if (department.id !== 'OTHER_TRIAGE') assert.deepEqual(Object.keys(casefile.details), Object.keys(department.details));
      assert.ok(result.data.activities.every((event) => {
        const ticketDivision = event.ticketId && database.prepare('SELECT division_id FROM tickets WHERE id=?').get(event.ticketId)?.division_id;
        const actorDivision = event.userId && database.prepare('SELECT r.division_id FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?').get(event.userId)?.division_id;
        return event.details.divisionId === department.id || ticketDivision === department.id || actorDivision === department.id;
      }));
    });
  });

  await t.test('every L1 role is limited to its assigned ward and department', async (t2) => {
    for (const department of departments.filter((entry) => entry.id !== 'OTHER_TRIAGE')) await t2.test(department.id, async () => {
      const { token } = await login(accounts.get(`L1-${department.id}`));
      const result = await request('/api/bootstrap', { token });
      assert.equal(result.data.tickets.length, 1);
      assert.equal(result.data.tickets[0].divisionId, department.id);
      assert.equal(result.data.tickets[0].wardId, 'WARD-101');
      assert.ok(result.data.activities.every((event) => event.userId === result.data.user.id));
    });
  });

  await t.test('every Appellate Authority sees appealed cases only in its own department', async (t2) => {
    for (const department of departments.filter((entry) => entry.id !== 'OTHER_TRIAGE')) await t2.test(department.id, async () => {
      const { token } = await login(accounts.get(`APP-${department.id}`));
      const result = await request('/api/bootstrap', { token });
      assert.equal(result.data.tickets.length, 1);
      assert.equal(result.data.tickets[0].divisionId, department.id);
      assert.ok(result.data.tickets.every((ticket) => ticket.category !== 'OTHER'));
      assert.ok(result.data.activities.every((event) => event.ticketId && database.prepare('SELECT division_id FROM tickets WHERE id=?').get(event.ticketId)?.division_id === department.id && database.prepare("SELECT json_extract(payload_json,'$.appealStatus') appeal FROM tickets WHERE id=?").get(event.ticketId)?.appeal === 'APPEALED'));
      const analytics = await request('/api/analytics/summary', { token });
      assert.equal(analytics.status, 200);
      assert.equal(analytics.data.total, 1);
    });
  });

  await t.test('ward supervisors see their ward queues but receive no foreign dynamic fields', async () => {
    const { token } = await login(accounts.get('WARD-ONE'));
    const oneWard = await request('/api/bootstrap', { token });
    assert.equal(oneWard.data.tickets.length, departments.length);
    assert.ok(oneWard.data.tickets.every((ticket) => ticket.wardId === 'WARD-101'));
    for (const ticket of oneWard.data.tickets) {
      assert.equal(Object.hasOwn(ticket, 'details'), false);
      assert.equal(Object.hasOwn(ticket, 'evidence'), false);
    }
    assert.deepEqual(oneWard.data.activities.map((event) => event.userId), oneWard.data.activities.map(() => oneWard.data.user.id));

    const { token: multiToken } = await login(accounts.get('WARD-TWO'));
    const multi = await request('/api/bootstrap', { token: multiToken });
    assert.equal(multi.data.tickets.length, departments.length + 1);
    assert.ok(multi.data.tickets.some((ticket) => ticket.wardId === 'WARD-102'));
    assert.ok(multi.data.tickets.every((ticket) => !Object.hasOwn(ticket, 'details')));
    assert.equal((await request('/api/analytics/summary', { token: multiToken })).status, 403);
  });

  await t.test('Staff Admin can read every synthetic department record and every dynamic field', async () => {
    const { token } = await login('staff-admin@scenario.invalid');
    const result = await request('/api/bootstrap', { token });
    assert.equal(result.data.tickets.length, departments.length + 1);
    for (const department of departments.filter((entry) => entry.id !== 'OTHER_TRIAGE')) {
      const ticket = result.data.tickets.find((entry) => entry.divisionId === department.id && entry.category === department.category);
      assert.deepEqual(Object.keys(ticket.details), Object.keys(department.details));
      assert.equal(ticket.evidence.length, 1);
    }
    const analytics = await request('/api/analytics/summary', { token });
    assert.equal(analytics.status, 200);
    assert.equal(analytics.data.total, departments.length + 1);
  });

  await t.test('permission and scope bypasses fail closed', async () => {
    const global = await login(accounts.get('LEGACY-GLOBAL'));
    assert.equal((await request('/api/bootstrap', { token: global.token })).data.tickets.length, 0);
    const noRead = await login(accounts.get('NO-READ'));
    assert.equal((await request('/api/bootstrap', { token: noRead.token })).data.tickets.length, 0);
    assert.equal((await request('/api/tickets', { token: noRead.token })).status, 403);

    assert.equal((await request('/api/roles', { token: (await login(accounts.get('DIV-CYBER_INFORMATION_SECURITY'))).token })).status, 403);
    const globalRole = await request('/api/roles', { token: adminToken, method: 'POST', body: { name: 'Synthetic Broad Role', description: 'Test only', scopeType: 'GLOBAL', permissions: ['tickets:read'], accessLevel: 'DIVISION_ADMIN' } });
    assert.equal(globalRole.status, 400);
    const invalidGrant = await request('/api/roles/ROLE-L1-CYBER_INFORMATION_SECURITY', { token: adminToken, method: 'PATCH', body: { name: 'Invalid L1 grant', permissions: ['tickets:read', 'analytics:view'], accessLevel: 'L1_RESOLVING_OFFICER' } });
    assert.equal(invalidGrant.status, 400);
    const promotedUser = await request('/api/users', { token: adminToken, method: 'POST', body: { name: 'Synthetic Admin Attempt', email: 'promotion@scenario.invalid', mobileNumber: '+91 90000 00000', roleId: 'ROLE-SUPER-ADMIN', assignedWards: [] } });
    assert.equal(promotedUser.status, 400);
    const promotedEdit = await request('/api/users/' + encodeURIComponent(accounts.get('DIV-CYBER_INFORMATION_SECURITY') && database.prepare('SELECT id FROM users WHERE email=?').get(accounts.get('DIV-CYBER_INFORMATION_SECURITY')).id), { token: adminToken, method: 'PATCH', body: { roleId: 'ROLE-SUPER-ADMIN' } });
    assert.equal(promotedEdit.status, 400);
  });

  await t.test('ward onboarding accepts division L1 roles and requires a chosen ward', async () => {
    const missingWard = await request('/api/users', { token: adminToken, method: 'POST', body: { name: 'Synthetic Missing Ward', email: 'missing-ward@scenario.invalid', mobileNumber: '+91 90000 00000', roleId: 'ROLE-L1-CYBER_INFORMATION_SECURITY', assignedWards: [] } });
    assert.equal(missingWard.status, 400);
    const created = await request('/api/users', { token: adminToken, method: 'POST', body: { name: 'Synthetic New L1', email: 'new-l1@scenario.invalid', mobileNumber: '+91 90000 00000', roleId: 'ROLE-L1-CYBER_INFORMATION_SECURITY', assignedWards: ['WARD-101'] } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const tempLogin = await login('new-l1@scenario.invalid', created.data.temporaryPassword);
    assert.equal(tempLogin.mustChangePassword, true);
    const changed = await request('/api/auth/change-password', { token: tempLogin.token, method: 'POST', body: { currentPassword: created.data.temporaryPassword, newPassword: 'Scenario-Updated-Password-2026' } });
    assert.equal(changed.status, 200);
    const freshLogin = await login('new-l1@scenario.invalid', 'Scenario-Updated-Password-2026');
    const inbox = await request('/api/bootstrap', { token: freshLogin.token });
    assert.equal(inbox.data.tickets.length, 1);
    assert.equal(inbox.data.tickets[0].divisionId, 'CYBER_INFORMATION_SECURITY');
  });

  await t.test('ticket updates enforce department and ward boundaries', async () => {
    const cyberId = ticketsByDivision.get('CYBER_INFORMATION_SECURITY:1');
    const immigrationId = ticketsByDivision.get('FOREIGNERS:2');
    const cyber = await login(accounts.get('DIV-CYBER_INFORMATION_SECURITY'));
    const denied = await request(`/api/tickets/${encodeURIComponent(immigrationId)}`, { token: cyber.token, method: 'PATCH', body: { status: 'RESOLVED', actionTakenReport: 'Synthetic cross-scope attempt' } });
    assert.equal(denied.status, 404);
    const saved = await request(`/api/tickets/${encodeURIComponent(cyberId)}`, { token: cyber.token, method: 'PATCH', body: { status: 'UNDER_INVESTIGATION', actionTakenReport: 'Synthetic report: routed to the appropriate desk.' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.status, 'UNDER_INVESTIGATION');
    assert.match(saved.data.actionTakenReport, /Synthetic report/);

    const l1 = await login(accounts.get('L1-CYBER_INFORMATION_SECURITY'));
    const wardDenied = await request(`/api/tickets/${encodeURIComponent(ticketsByDivision.get('CYBER_INFORMATION_SECURITY:99'))}`, { token: l1.token, method: 'PATCH', body: { status: 'RESOLVED' } });
    assert.equal(wardDenied.status, 404);

    const appellate = await login(accounts.get('APP-CYBER_INFORMATION_SECURITY'));
    const appealDenied = await request(`/api/tickets/${encodeURIComponent(ticketsByDivision.get('CYBER_INFORMATION_SECURITY:99'))}`, { token: appellate.token, method: 'PATCH', body: { status: 'RESOLVED' } });
    assert.equal(appealDenied.status, 404);
    const appealResolved = await request(`/api/tickets/${encodeURIComponent(cyberId)}`, { token: appellate.token, method: 'PATCH', body: { status: 'RESOLVED', actionTakenReport: 'Synthetic appellate override report.' } });
    assert.equal(appealResolved.status, 200);
    assert.equal(appealResolved.data.status, 'RESOLVED');
  });

  await t.test('Other Case Triage routes to a destination desk without retaining untrusted dynamic fields', async () => {
    const otherId = ticketsByDivision.get('OTHER_TRIAGE:16');
    const triage = await login(accounts.get('OTHER-TRIAGE'));
    const queue = await request('/api/bootstrap', { token: triage.token });
    assert.equal(queue.data.tickets.length, 1);
    assert.equal(queue.data.tickets[0].divisionId, 'OTHER_TRIAGE');
    assert.deepEqual(queue.data.tickets[0].details, {});
    assert.equal(queue.data.tickets[0].evidence.length, 1);
    const cannotResolve = await request(`/api/tickets/${encodeURIComponent(otherId)}`, { token: triage.token, method: 'PATCH', body: { status: 'RESOLVED' } });
    assert.equal(cannotResolve.status, 403);
    const routed = await request(`/api/tickets/${encodeURIComponent(otherId)}`, { token: triage.token, method: 'PATCH', body: { routeToDivisionId: 'CYBER_INFORMATION_SECURITY' } });
    assert.equal(routed.status, 200);
    const stored = database.prepare('SELECT division_id,category,payload_json FROM tickets WHERE id=?').get(otherId);
    assert.equal(stored.division_id, 'CYBER_INFORMATION_SECURITY');
    assert.equal(stored.category, 'CYBERCRIME');
    assert.equal(JSON.parse(stored.payload_json).details, undefined);
    assert.equal(JSON.parse(stored.payload_json).evidence.length, 1);
    assert.equal((await request('/api/bootstrap', { token: triage.token })).data.tickets.length, 0);
    const cyber = await login(accounts.get('DIV-CYBER_INFORMATION_SECURITY'));
    const cyberQueue = await request('/api/bootstrap', { token: cyber.token });
    assert.ok(cyberQueue.data.tickets.some((ticket) => ticket.id === otherId));
  });
});
