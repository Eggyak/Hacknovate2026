# MHA Grievance Department Workspace

A local full-stack prototype for the department workspace. It uses React + TypeScript, a Vite frontend, an Express API, and a persistent SQLite database.

## Start it on Windows

1. Install Node.js 20.19+ or 22.12+.
2. Double-click `START_MHA_DASHBOARD.bat`.
3. The launcher starts the API and frontend. Open `http://localhost:5173` and keep the command window open.

The frontend runs at port 5173 and proxies `/api` requests to the API on port 3001. SQLite creates `data/mha-grievance.sqlite` automatically at first start.

## Sign in and account setup

On a fresh database, the sign-in page asks you to create the first Super Admin account. Choose a department email and a password of at least 12 characters. That account manages staff and roles from the **User access** and **Roles & permissions** panels.

There is no public account directory or shared demo password. Super Admin onboarding generates a random one-time password for each staff member and displays it once alongside the department email. Share those credentials securely; the staff member must change the temporary password at first sign-in. Password reset generates a new one-time password and revokes the account's active sessions.

For an existing database, startup removes the bundled sample identities once and preserves custom accounts. Create the initial Super Admin through the setup form after this migration.

The sign-in cookie is HTTP-only. The API stores only a SHA-256 hash of each random session token. Passwords are stored as bcrypt hashes. Role, division, and ward checks happen in the API before ticket records are returned or changed.

## Data stored in SQLite

`roles`, `users`, `wards`, `tickets`, `sessions`, and `activity_events` are created on first run. Ticket payloads contain the shared complaint fields and typed category-specific details. Status changes, officer reports, account changes, and sign-in events are persisted.

The first run seeds 90 synthetic grievances distributed across all 15 modeled MHA divisions and eight wards. Names, phone numbers, case references, and complaint narratives are fictional. Aadhaar, account, passport, and suspect-like values are masked or non-actionable synthetic values. The records are for demonstration only.

## API routes

- `GET /api/auth/setup-status`, `POST /api/auth/initial-admin` (only while no accounts exist)
- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/change-password`
- `GET /api/bootstrap` returns the current user's scoped queue and permitted workspace data
- `GET /api/tickets`; `PATCH /api/tickets/:id` for authorized case status and report updates
- `POST /api/intake/grievances` accepts a validated, rate-limited citizen intake and stores it with a 21-day SLA deadline
- `GET/POST /api/roles` for Super Admin role management
- `GET/POST /api/users`, `PATCH /api/users/:id`, and `POST /api/users/:id/reset-password`
- `GET /api/analytics/summary`, `GET /api/activity`, and `GET /api/health`

The citizen intake endpoint can be called by the partner chatbot backend. It should remain behind additional abuse prevention and validation before any public deployment.

## Build

`npm run build` compiles TypeScript and creates the frontend production bundle in `dist/`. `npm run server` starts only the API. `npm run dev` starts only Vite; use the batch launcher or `npm run start:local` for both.

Back up the database after stopping the server by copying `data/mha-grievance.sqlite`. Do not copy the WAL files while the API is running.

## Prototype boundary

This is a local hackathon demo, not a production MHA service. Before deployment, add HTTPS, CSRF/origin protections for the chosen hosting model, password reset/change flows, stronger password policy, audited admin changes, encrypted evidence storage, backups, operational monitoring, and review the privacy/legal requirements for citizen data. Never enter real citizen PII in the synthetic demo database.
