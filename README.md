# MHA Grievance Department Workspace

A full-stack hackathon prototype for the staff side of a multilingual, voice-first grievance workflow. The workspace combines a React and TypeScript dashboard, an Express API, and a local SQLite database. A separate citizen chatbot can submit grievances through the intake API.

> **Prototype notice:** This is an independent hackathon project, not an official Ministry of Home Affairs service. Do not enter real citizen personal or sensitive information. The current intake API and local security controls are not ready for public production use.

## What it includes

- Staff sign-in, first Staff Admin setup, password rotation, account onboarding, suspension, and password reset.
- A department and role administration area with permission modules.
- Department queues, ward scope filtering, ticket review, status changes, and action taken reports.
- A standalone **Other Cases Triage** department that can route `OTHER` cases to a recognized MHA department.
- Category-specific ticket details for 15 modeled MHA divisions, plus Other triage.
- An Express JSON API backed by SQLite.
- Integration tests that exercise department, hierarchy, permission, ward, and ticket data boundaries using temporary synthetic data.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| Styling | Tailwind CSS and project CSS |
| API | Node.js, Express |
| Database | SQLite via `better-sqlite3` |
| Password hashing | `bcryptjs` |
| Security middleware | Helmet, express-rate-limit |

## Run locally on Windows

1. Install Node.js 20.19+ or 22.12+.
2. Double-click [`START_MHA_DASHBOARD.bat`](START_MHA_DASHBOARD.bat), or run the commands below from the project folder.
3. Open [http://localhost:5173](http://localhost:5173).
4. Keep the terminal window open while using the dashboard. Press `Ctrl+C` to stop the services.

```powershell
npm install
npm run start:local
```

The Vite frontend listens on port `5173` and proxies `/api` requests to the Express API on `127.0.0.1:3001`. On first startup, the API creates `data/mha-grievance.sqlite` and seeds the ward and role catalog. The database folder and SQLite files are ignored by Git.

## First sign-in and staff accounts

On a new database, the sign-in screen offers initial Staff Admin setup. Create the first administrator with a department email and a password of at least 8 characters. The account can then use **User access** and **Roles & permissions** to manage staff and roles.

Staff onboarding generates a random temporary password and displays it once. Share it with the staff member through an appropriate secure channel. They must set a new password at first sign-in. A password reset also issues a one-time password and revokes the account's existing sessions.

There are no public demo accounts or shared demo passwords. Each browser tab keeps its staff token in `sessionStorage`, so separate tabs can sign into different staff accounts. Staff credentials are separate from citizen chatbot identities.

## Departments and ticket categories

The API uses stable division IDs and category IDs. Send IDs in requests; display labels are for humans and may change.

| Division ID | Ticket category |
| --- | --- |
| `CYBER_INFORMATION_SECURITY` | `CYBERCRIME` |
| `FOREIGNERS` | `IMMIGRATION` |
| `DISASTER_MANAGEMENT` | `DISASTER_RELIEF` |
| `UT_ADMINISTRATION` | `UT_ADMIN` |
| `FREEDOM_FIGHTERS_REHABILITATION` | `FREEDOM_FIGHTERS_REHABILITATION` |
| `CENTRAL_ARMED_POLICE_FORCES` | `CAPF_MISCONDUCT` |
| `NGO_FCRA` | `FCRA_NGO` |
| `INTERNAL_SECURITY` | `INTERNAL_SECURITY` |
| `COUNTER_TERRORISM` | `COUNTER_TERRORISM` |
| `LWE_NORTH_EAST` | `LWE_NORTH_EAST` |
| `BORDER_MANAGEMENT` | `BORDER_MANAGEMENT` |
| `JUDICIAL` | `JUDICIAL` |
| `POLICE` | `POLICE` |
| `CENTRE_STATE` | `CENTRE_STATE` |
| `INTERNAL_ADMINISTRATION` | `INTERNAL_DIVISIONS` |
| `OTHER_TRIAGE` | `OTHER` |

Department payload keys are documented in [`artifacts/MHA Grievance Workspace Integration Guide.docx`](artifacts/MHA%20Grievance%20Workspace%20Integration%20Guide.docx) and modeled in [`src/types/grievance.ts`](src/types/grievance.ts).

## Role hierarchy and access

Department membership is the horizontal boundary. The officer's access level controls what they can do within that department. Scope applies an additional restriction to the ticket set. The API applies the checks before returning or changing tickets.

| Access level | Scope | Effective permission ceiling | Ticket access |
| --- | --- | --- | --- |
| Staff Admin (`SUPER_ADMIN`) | Global | Read, resolve, reroute, manage users, analytics | All departments and wards; manages staff and roles |
| Division Admin | One division | Read, resolve, reroute, analytics | Tickets in the assigned division |
| L1 Resolving Officer | Ward(s) within a division | Read, resolve, reroute | Intersection of assigned wards and assigned division |
| Appellate Authority | One division | Read, resolve, analytics | Appealed tickets in the assigned division |
| Other Case Triage Officer | `OTHER_TRIAGE` division only | Read, reroute | `OTHER` tickets; can route to a regular division, cannot resolve |

The five permission keys are `tickets:read`, `tickets:resolve`, `tickets:reroute`, `users:manage`, and `analytics:view`. Permission grants are capped by access level on the server. Custom global roles are not allowed; the protected Staff Admin role is the only global role. Generic ward-only roles can span divisions by ward, but sensitive category-specific fields and evidence are stripped from those cross-department responses.

## Data model

SQLite tables are created by [`server/db.js`](server/db.js):

- `roles`: permission list, scope, division, optional ward IDs, and access level.
- `users`: staff identity, password hash, role assignment, ward assignments, active state, and sign-in metadata.
- `wards`: ward name, district, state, pincode prefix, and zone.
- `tickets`: indexed grievance ID, ward, division, category, status, SLA state, timestamps, and JSON payload.
- `sessions`: SHA-256 hashes of random session tokens and expiry times.
- `activity_events`: staff, authentication, role, and ticket action records.
- `app_migrations`: one-time database migration markers.

The ticket JSON payload contains complainant profile, location, detected language, regional and English text, audio URL, evidence metadata, and department-specific `details`. The server returns dynamic details to staff whose role belongs to the ticket's division. Ticket fields for a different division are not returned to that role. Ward roles without a department assignment receive redacted category details and evidence.

## API overview

The API is implemented in [`server/index.js`](server/index.js). For the complete request/response and field contract, see the integration guide linked above.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /api/health` | Public | API and database health |
| `GET /api/auth/setup-status` | Public | Check whether initial Staff Admin setup is needed |
| `POST /api/auth/initial-admin` | Public, one-time | Create the first Staff Admin |
| `POST /api/auth/login` | Public | Staff sign-in; returns bearer token and effective role |
| `GET /api/auth/me` | Bearer token | Current staff identity and role |
| `POST /api/auth/logout` | Bearer token | Revoke the current session |
| `POST /api/auth/change-password` | Bearer token | Set or change a password |
| `POST /api/auth/forgot-password` | Public | Record a request to contact Staff Admin; does not send email |
| `GET /api/bootstrap` | Bearer token | Load role-scoped workspace data |
| `GET /api/tickets` | `tickets:read` | Load visible tickets (up to 500) |
| `POST /api/intake/grievances` | Public, rate limited | Create a citizen grievance |
| `PATCH /api/tickets/:id` | Bearer token + required action permission | Update status/report or route an Other case |
| `GET`, `POST`, `PATCH /api/roles` | Staff Admin | List, create, and edit roles |
| `GET`, `POST`, `PATCH /api/users` | Staff Admin | List, onboard, edit, and suspend staff accounts |
| `POST /api/users/:id/reset-password` | Staff Admin | Issue a temporary password and revoke sessions |
| `GET /api/analytics/summary` | `analytics:view` | Scoped status and SLA counts |
| `GET /api/activity` | `analytics:view` | Scoped activity feed |

### Citizen intake example

The chatbot backend can submit a grievance to `POST /api/intake/grievances`:

```json
{
  "complainantName": "Synthetic Example Citizen",
  "mobileNumber": "+91 90000 00000",
  "wardId": "WARD-101",
  "divisionId": "CYBER_INFORMATION_SECURITY",
  "category": "CYBERCRIME",
  "detectedLanguage": "Hindi",
  "originalRegionalText": "[synthetic] Regional-language complaint",
  "translatedEnglishText": "[synthetic] English translation",
  "details": {
    "transactionId": "SYN-UTR-001",
    "amountLost": 1000,
    "fraudDateTime": "2026-10-01T10:00:00Z",
    "platformUsed": "Synthetic UPI",
    "suspectDetails": "synthetic@example"
  },
  "audioFileUrl": "https://approved-storage.example/object-id",
  "evidence": []
}
```

On success, the API returns `201` with `{ "ticket": ... }`, assigns the grievance ID, sets the initial status to `PENDING`, and sets a 21-day deadline. `OTHER` complaints must use `divisionId: "OTHER_TRIAGE"`; Other triage can route a case with `PATCH /api/tickets/:id` and `{ "routeToDivisionId": "CYBER_INFORMATION_SECURITY" }`.

**Intake is not production-secured:** it currently has no caller authentication, no idempotency key, no OTP verification, and only basic runtime validation. It accepts audio/evidence references but does not upload or scan files. Do not expose it publicly without a trusted gateway, strict validation, abuse controls, and storage/access policies.

## Development commands

```bash
npm install
npm run dev          # Vite frontend only
npm run server       # Express API only
npm run start:local  # API and Vite together
npm run build        # TypeScript project build and Vite production bundle
npm run test:rbac    # End-to-end RBAC scenarios with a temporary SQLite database
```

The RBAC tests create synthetic records in an isolated temporary database and remove it when complete. They do not add synthetic grievances to the normal app database. The current app database seeds wards and roles, not demo ticket records.

## Project layout

```text
src/
  App.tsx                  React workspace, auth and API client
  data/mockData.ts         Initial role and ward UI data
  types/grievance.ts       TypeScript data contracts
  styles.css               Workspace styles
server/
  db.js                    SQLite schema, migrations, role seeds
  index.js                 Authentication and JSON API
scripts/
  rbac.integration.test.mjs Isolated end-to-end access tests
artifacts/
  MHA Grievance Workspace Integration Guide.docx
```

## Prototype limitations and production work

This project is a local hackathon prototype, not an official MHA service. Before using real citizen data or deploying publicly:

- Put the API behind HTTPS and an authenticated service gateway; define CORS, origin, and CSRF controls for the deployment model.
- Add durable rate limiting, idempotent intake, deep schema validation, and verified citizen identity/OTP where required.
- Add secure audio/evidence upload, access-controlled storage, malware scanning, retention, and deletion workflows.
- Add a trusted appeal submission flow; appellate queues currently depend on `appealStatus: "APPEALED"`, but no appeal intake API exists.
- Add SLA recalculation and citizen status/notification services; the API currently sets a 21-day deadline but does not schedule status transitions or send notifications/translations.
- Add external tamper-resistant audit storage, backup/restore procedures, monitoring, and privacy/legal review.
- Use synthetic test data until data protection, access policies, and operating procedures are approved.

Back up the local database only after stopping the API. The database file is `data/mha-grievance.sqlite`; do not copy SQLite WAL files while the server is running.
