import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = resolve(process.env.MHA_DATABASE_PATH ?? 'data/mha-grievance.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  permissions_json TEXT NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN ('GLOBAL','DIVISION','WARD')),
  division_id TEXT, ward_ids_json TEXT NOT NULL DEFAULT '[]', is_system INTEGER NOT NULL DEFAULT 0,
  access_level TEXT NOT NULL DEFAULT 'DIVISION_ADMIN',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  mobile_number TEXT NOT NULL, password_hash TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id),
  assigned_wards_json TEXT NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1,
  avatar_initials TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_sign_in TEXT,
  password_reset_at TEXT
);
CREATE TABLE IF NOT EXISTS wards (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, district TEXT NOT NULL, state TEXT NOT NULL,
  pincode_prefix TEXT NOT NULL, zone TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, grievance_id TEXT NOT NULL UNIQUE, complainant_name TEXT NOT NULL,
  mobile_number TEXT NOT NULL, ward_id TEXT NOT NULL REFERENCES wards(id), division_id TEXT NOT NULL,
  category TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','UNDER_INVESTIGATION','RESOLVED')),
  sla_status TEXT NOT NULL CHECK(sla_status IN ('ON_TIME','WARNING','OVERDUE')),
  submission_timestamp TEXT NOT NULL, sla_deadline TEXT NOT NULL, payload_json TEXT NOT NULL,
  action_taken_report TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tickets_ward ON tickets(ward_id);
CREATE INDEX IF NOT EXISTS idx_tickets_division ON tickets(division_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id), ticket_id TEXT REFERENCES tickets(id),
  event_type TEXT NOT NULL, summary TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON activity_events(created_at DESC);
CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

const ticketColumns = db.prepare('PRAGMA table_info(tickets)').all().map(column => column.name);
if (!ticketColumns.includes('assigned_user_id')) {
  db.exec('ALTER TABLE tickets ADD COLUMN assigned_user_id TEXT REFERENCES users(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assigned_user_id)');
}
// When a member of staff first acted, and when the case was closed. Both
// are written once and never moved, so the response-time figures cannot
// drift the way updated_at would.
if (!ticketColumns.includes('first_action_at')) db.exec('ALTER TABLE tickets ADD COLUMN first_action_at TEXT');
if (!ticketColumns.includes('resolved_at')) db.exec('ALTER TABLE tickets ADD COLUMN resolved_at TEXT');

const roleColumns = db.prepare('PRAGMA table_info(roles)').all().map(column => column.name);
if (!roleColumns.includes('access_level')) db.exec("ALTER TABLE roles ADD COLUMN access_level TEXT NOT NULL DEFAULT 'DIVISION_ADMIN'");

// Keep existing SQLite databases compatible with password rotation metadata.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
if (!userColumns.includes('must_change_password')) db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
if (!userColumns.includes('password_reset_at')) db.exec('ALTER TABLE users ADD COLUMN password_reset_at TEXT');

// Remove bundled demo users and synthetic records
if (!db.prepare("SELECT 1 FROM app_migrations WHERE id='remove-bundled-demo-users'").get()) {
  db.transaction(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare("UPDATE activity_events SET user_id=NULL WHERE user_id IN (SELECT id FROM users WHERE id='USER-001' OR id GLOB 'USER-00[2-4]' OR id GLOB 'USER-DIV-*')").run();
    db.prepare("DELETE FROM users WHERE id='USER-001' OR id GLOB 'USER-00[2-4]' OR id GLOB 'USER-DIV-*'").run();
    db.prepare("INSERT INTO app_migrations(id) VALUES('remove-bundled-demo-users')").run();
  })();
}

// Purge any synthetic demo tickets and fake activity events
if (!db.prepare("SELECT 1 FROM app_migrations WHERE id='purge-synthetic-demo-data'").get()) {
  db.transaction(() => {
    db.prepare("DELETE FROM activity_events").run();
    db.prepare("DELETE FROM tickets").run();
    db.prepare("INSERT INTO app_migrations(id) VALUES('purge-synthetic-demo-data')").run();
  })();
}

export const permissions = ['tickets:read','tickets:resolve','tickets:reroute','users:manage','analytics:view'];
export const accessLevelPermissionGrants = {
  SUPER_ADMIN: permissions,
  DIVISION_ADMIN: ['tickets:read','tickets:resolve','tickets:reroute','analytics:view'],
  L1_RESOLVING_OFFICER: ['tickets:read','tickets:resolve','tickets:reroute'],
  APPELLATE_AUTHORITY: ['tickets:read','tickets:resolve','analytics:view'],
  OTHER_CASE_TRIAGE: ['tickets:read','tickets:reroute'],
};
export const divisions = [
  ['CYBER_INFORMATION_SECURITY','Cyber & Information Security','CYBERCRIME'],
  ['FOREIGNERS','Foreigners Division','IMMIGRATION'],
  ['DISASTER_MANAGEMENT','Disaster Management','DISASTER_RELIEF'],
  ['UT_ADMINISTRATION','Union Territory Administration','UT_ADMIN'],
  ['FREEDOM_FIGHTERS_REHABILITATION','Freedom Fighters & Rehabilitation','FREEDOM_FIGHTERS_REHABILITATION'],
  ['CENTRAL_ARMED_POLICE_FORCES','Central Armed Police Forces','CAPF_MISCONDUCT'],
  ['NGO_FCRA','NGO & FCRA','FCRA_NGO'],
  ['INTERNAL_SECURITY','Internal Security','INTERNAL_SECURITY'],
  ['COUNTER_TERRORISM','Counter Terrorism & Counter Radicalization','COUNTER_TERRORISM'],
  ['LWE_NORTH_EAST','LWE & North East','LWE_NORTH_EAST'],
  ['BORDER_MANAGEMENT','Border Management','BORDER_MANAGEMENT'],
  ['JUDICIAL','Judicial Division','JUDICIAL'],
  ['POLICE','Police Divisions','POLICE'],
  ['CENTRE_STATE','Centre-State Division','CENTRE_STATE'],
  ['INTERNAL_ADMINISTRATION','Internal Divisions','INTERNAL_DIVISIONS'],
  ['OTHER_TRIAGE','Other Cases Triage','OTHER'],
];

export const toRole = row => row && ({
  id: row.id, name: row.name, description: row.description,
  permissions: JSON.parse(row.permissions_json).filter(permission => (accessLevelPermissionGrants[row.access_level ?? (row.id==='ROLE-SUPER-ADMIN'?'SUPER_ADMIN':row.scope_type==='WARD'?'L1_RESOLVING_OFFICER':'DIVISION_ADMIN')] ?? []).includes(permission)),
  scopeType: row.scope_type, ...(row.division_id ? { divisionId: row.division_id } : {}),
  wardIds: JSON.parse(row.ward_ids_json), isSystem: Boolean(row.is_system), accessLevel: row.access_level ?? (row.id==='ROLE-SUPER-ADMIN'?'SUPER_ADMIN':row.scope_type==='WARD'?'L1_RESOLVING_OFFICER':'DIVISION_ADMIN'),
});
export const toUser = row => row && ({
  id: row.id, name: row.name, email: row.email, mobileNumber: row.mobile_number, roleId: row.role_id,
  assignedWards: JSON.parse(row.assigned_wards_json), isActive: Boolean(row.is_active), avatarInitials: row.avatar_initials,
  ...(row.last_sign_in ? { lastSignIn: row.last_sign_in } : {}),
});
export const toTicket = row => {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json);
  return {
    ...payload, id: row.id, grievanceId: row.grievance_id, complainantName: row.complainant_name,
    mobileNumber: row.mobile_number, wardId: row.ward_id, divisionId: row.division_id, category: row.category,
    status: row.status, slaStatus: row.sla_status, submissionTimestamp: row.submission_timestamp,
    slaDeadline: row.sla_deadline, ...(row.action_taken_report ? { actionTakenReport: row.action_taken_report } : {}),
    assignedUserId: row.assigned_user_id ?? null,
    firstActionAt: row.first_action_at ?? null,
    resolvedAt: row.resolved_at ?? null,
  };
};

export const publicUserQuery = db.prepare(`SELECT u.id,u.name,u.email,u.mobile_number,u.role_id,u.assigned_wards_json,u.is_active,u.avatar_initials,u.last_sign_in FROM users u`);
export const getUserById = db.prepare('SELECT * FROM users WHERE id=?');
export const getRoleById = db.prepare('SELECT * FROM roles WHERE id=?');

const wardSeeds = [
  ['WARD-101','Connaught Place','New Delhi','Delhi','110001','Central'],
  ['WARD-102','Karol Bagh','New Delhi','Delhi','110005','Central'],
  ['WARD-103','Dwarka Sector 10','South West Delhi','Delhi','110075','South West'],
  ['WARD-104','Andheri East','Mumbai Suburban','Maharashtra','400069','K East'],
  ['WARD-105','T Nagar','Chennai','Tamil Nadu','600017','Central'],
  ['WARD-106','Lal Chowk','Srinagar','Jammu and Kashmir','190001','Srinagar'],
  ['WARD-107','Dispur','Kamrup Metropolitan','Assam','781006','Guwahati'],
  ['WARD-108','Salt Lake','North 24 Parganas','West Bengal','700091','Bidhannagar'],
];

/*
 * A state-level ward for every state and union territory.
 *
 * Intake refuses a wardId that is not in this table, and the eight seeded
 * wards cover six cities - so a complaint from Punjab or Odisha had nowhere
 * to land, and the only alternatives were to reject real citizens or quietly
 * file them under a Delhi ward. Both are worse than carrying a state-level
 * desk until the real ward list exists.
 *
 * These are additive and idempotent: the original eight are untouched and
 * remain the preferred match, because a city ward is a better answer than a
 * state one whenever the PIN code reaches it.
 */
const statewideWardSeeds = [
  ['WARD-ST-DL','Delhi (statewide)','Delhi','Delhi','11','Statewide'],
  ['WARD-ST-HR','Haryana (statewide)','Haryana','Haryana','12','Statewide'],
  ['WARD-ST-PB','Punjab (statewide)','Punjab','Punjab','14','Statewide'],
  ['WARD-ST-CH','Chandigarh (statewide)','Chandigarh','Chandigarh','16','Statewide'],
  ['WARD-ST-HP','Himachal Pradesh (statewide)','Himachal Pradesh','Himachal Pradesh','17','Statewide'],
  ['WARD-ST-JK','Jammu and Kashmir (statewide)','Jammu and Kashmir','Jammu and Kashmir','18','Statewide'],
  ['WARD-ST-UP','Uttar Pradesh (statewide)','Uttar Pradesh','Uttar Pradesh','20','Statewide'],
  ['WARD-ST-UK','Uttarakhand (statewide)','Uttarakhand','Uttarakhand','24','Statewide'],
  ['WARD-ST-RJ','Rajasthan (statewide)','Rajasthan','Rajasthan','30','Statewide'],
  ['WARD-ST-GJ','Gujarat (statewide)','Gujarat','Gujarat','36','Statewide'],
  ['WARD-ST-MH','Maharashtra (statewide)','Maharashtra','Maharashtra','40','Statewide'],
  ['WARD-ST-MP','Madhya Pradesh (statewide)','Madhya Pradesh','Madhya Pradesh','45','Statewide'],
  ['WARD-ST-CG','Chhattisgarh (statewide)','Chhattisgarh','Chhattisgarh','49','Statewide'],
  ['WARD-ST-TG','Telangana (statewide)','Telangana','Telangana','50','Statewide'],
  ['WARD-ST-AP','Andhra Pradesh (statewide)','Andhra Pradesh','Andhra Pradesh','51','Statewide'],
  ['WARD-ST-KA','Karnataka (statewide)','Karnataka','Karnataka','56','Statewide'],
  ['WARD-ST-TN','Tamil Nadu (statewide)','Tamil Nadu','Tamil Nadu','60','Statewide'],
  ['WARD-ST-PY','Puducherry (statewide)','Puducherry','Puducherry','605','Statewide'],
  ['WARD-ST-KL','Kerala (statewide)','Kerala','Kerala','67','Statewide'],
  ['WARD-ST-LD','Lakshadweep (statewide)','Lakshadweep','Lakshadweep','682','Statewide'],
  ['WARD-ST-WB','West Bengal (statewide)','West Bengal','West Bengal','70','Statewide'],
  ['WARD-ST-AN','Andaman and Nicobar Islands (statewide)','Andaman and Nicobar Islands','Andaman and Nicobar Islands','744','Statewide'],
  ['WARD-ST-OR','Odisha (statewide)','Odisha','Odisha','75','Statewide'],
  ['WARD-ST-AS','Assam (statewide)','Assam','Assam','78','Statewide'],
  ['WARD-ST-NE','North Eastern States (statewide)','North Eastern States','North Eastern States','79','Statewide'],
  ['WARD-ST-BR','Bihar (statewide)','Bihar','Bihar','80','Statewide'],
  ['WARD-ST-JH','Jharkhand (statewide)','Jharkhand','Jharkhand','82','Statewide'],
];

export function seedDatabase() {
  const roleCount = db.prepare('SELECT COUNT(*) AS count FROM roles').get().count;
  if (roleCount === 0) {
    const insertRole = db.prepare('INSERT INTO roles(id,name,description,permissions_json,scope_type,division_id,ward_ids_json,is_system) VALUES(?,?,?,?,?,?,?,?)');
    const roleRows = [
      ['ROLE-SUPER-ADMIN','Staff Admin','National oversight and administration.',permissions,'GLOBAL',null,[],1],
      ['ROLE-WARD-DESK','Ward Desk Officer','Local grievance queue for assigned wards.',['tickets:read','tickets:resolve','tickets:reroute'],'WARD',null,['WARD-101'],1],
      ['ROLE-MULTI-WARD','Multi-Ward Supervisor','Supervision for assigned wards.',['tickets:read','tickets:resolve','tickets:reroute','analytics:view'],'WARD',null,['WARD-101','WARD-102'],1],
      ...divisions.filter(([id])=>id!=='OTHER_TRIAGE').map(([id,name])=>[`ROLE-${id}`,`${name} Officer`,`Division-scoped grievance desk for ${name}.`,['tickets:read','tickets:resolve','tickets:reroute','analytics:view'],'DIVISION',id,[],1]),
    ];
    const insertW = db.prepare('INSERT OR IGNORE INTO wards(id,name,district,state,pincode_prefix,zone) VALUES(?,?,?,?,?,?)');
    const tx = db.transaction(() => {
      roleRows.forEach(([id,name,description,perms,scope,division,wardIds,isSystem])=>insertRole.run(id,name,description,JSON.stringify(perms),scope,division,JSON.stringify(wardIds),isSystem));
      wardSeeds.forEach(ward=>insertW.run(...ward));
    }); tx();
  }
  db.prepare("UPDATE roles SET access_level='SUPER_ADMIN' WHERE id='ROLE-SUPER-ADMIN'").run();
  db.prepare("UPDATE roles SET access_level='L1_RESOLVING_OFFICER' WHERE scope_type='WARD' AND id<>'ROLE-SUPER-ADMIN'").run();
  db.prepare("UPDATE roles SET access_level='DIVISION_ADMIN' WHERE scope_type='DIVISION'").run();
  const levels = divisions.filter(([divisionId])=>divisionId!=='OTHER_TRIAGE').map(([divisionId,label])=>[divisionId,label]);
  const addLevelRole = db.prepare('INSERT OR IGNORE INTO roles(id,name,description,permissions_json,scope_type,division_id,ward_ids_json,is_system,access_level) VALUES(?,?,?,?,?,?,?,?,?)');
  for (const [divisionId, label] of levels) {
    const base = `ROLE-${divisionId}`;
    const definition = db.prepare('SELECT permissions_json FROM roles WHERE id=?').get(base);
    const perms = definition?.permissions_json ?? JSON.stringify(['tickets:read','tickets:resolve','tickets:reroute']);
    addLevelRole.run(`ROLE-L1-${divisionId}`, `${label} · L1 Resolving Officer`, `Assigned-ward case handling for ${label}.`, JSON.stringify(['tickets:read','tickets:resolve','tickets:reroute']), 'WARD', divisionId, '[]', 1, 'L1_RESOLVING_OFFICER');
    addLevelRole.run(`ROLE-APPEAL-${divisionId}`, `${label} · Appellate Authority`, `Appeals-only review for ${label}.`, JSON.stringify(['tickets:read','tickets:resolve','analytics:view']), 'DIVISION', divisionId, '[]', 1, 'APPELLATE_AUTHORITY');
  }
  // Retire the former cross-department triage role. Keep any associated account
  // working with the least-privileged ward role until an administrator reassigns it.
  // Statewide desks, so citizen intake from any state has a valid ward.
  if (!db.prepare("SELECT 1 FROM app_migrations WHERE id='statewide-wards-for-intake'").get()) {
    const insertStatewide = db.prepare('INSERT OR IGNORE INTO wards(id,name,district,state,pincode_prefix,zone) VALUES(?,?,?,?,?,?)');
    db.transaction(() => {
      for (const ward of statewideWardSeeds) insertStatewide.run(...ward);
      db.prepare("INSERT INTO app_migrations(id) VALUES('statewide-wards-for-intake')").run();
    })();
  }

  if (!db.prepare("SELECT 1 FROM app_migrations WHERE id='retire-other-triage-role'").get()) {
    db.transaction(() => {
      const legacyRole = db.prepare("SELECT 1 FROM roles WHERE id='ROLE-OTHER-CASE-TRIAGE'").get();
      const wardRole = db.prepare("SELECT id FROM roles WHERE id='ROLE-WARD-DESK'").get();
      if (legacyRole && wardRole) db.prepare("UPDATE users SET role_id=? WHERE role_id='ROLE-OTHER-CASE-TRIAGE'").run(wardRole.id);
      db.prepare("DELETE FROM roles WHERE id='ROLE-OTHER-CASE-TRIAGE'").run();
      db.prepare("INSERT INTO app_migrations(id) VALUES('retire-other-triage-role')").run();
    })();
  }
  addLevelRole.run('ROLE-OTHER-CASE-TRIAGE','Other Case Triage Officer','Reviews complaints assigned to the Other department and routes them to the correct MHA division.',JSON.stringify(['tickets:read','tickets:reroute']),'DIVISION','OTHER_TRIAGE','[]',1,'OTHER_CASE_TRIAGE');
  if (!db.prepare("SELECT 1 FROM app_migrations WHERE id='appellate-action-report-permission'").get()) {
    db.transaction(() => {
      const appellateRoles = db.prepare("SELECT id,permissions_json FROM roles WHERE access_level='APPELLATE_AUTHORITY' AND is_system=1").all();
      for (const role of appellateRoles) {
        const rolePermissions = JSON.parse(role.permissions_json);
        if (!rolePermissions.includes('tickets:resolve')) rolePermissions.push('tickets:resolve');
        db.prepare('UPDATE roles SET permissions_json=? WHERE id=?').run(JSON.stringify(rolePermissions), role.id);
      }
      db.prepare("INSERT INTO app_migrations(id) VALUES('appellate-action-report-permission')").run();
    })();
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export const ticketById = db.prepare('SELECT * FROM tickets WHERE id=?');
export const userByEmail = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE');
export const rolesList = db.prepare('SELECT * FROM roles ORDER BY scope_type,name');
export const wardsList = db.prepare('SELECT * FROM wards ORDER BY id');
export const getWardById = db.prepare('SELECT * FROM wards WHERE id=?');
export const usersList = db.prepare(`SELECT id,name,email,mobile_number,role_id,assigned_wards_json,is_active,avatar_initials,last_sign_in FROM users ORDER BY name`);
export const userDirectoryList = db.prepare(`SELECT id,name,email,mobile_number,role_id,assigned_wards_json,is_active,avatar_initials,last_sign_in FROM users ORDER BY name`);
export const eventsList = db.prepare(`SELECT e.id,e.user_id,e.ticket_id,e.event_type,e.summary,e.details_json,e.created_at,u.name AS actor_name,t.grievance_id,t.division_id AS ticket_division_id,t.ward_id AS ticket_ward_id,CASE WHEN json_extract(t.payload_json,'$.appealStatus')='APPEALED' THEN 1 ELSE 0 END AS ticket_appealed,r.division_id AS actor_division_id FROM activity_events e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN roles r ON r.id=u.role_id LEFT JOIN tickets t ON t.id=e.ticket_id ORDER BY e.id DESC LIMIT 50`);
