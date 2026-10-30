# MHA Samadhan — Android client

**A build specification for one app that serves two very different people.**

A citizen files a grievance in their own language, by voice or by typing, and
follows it until it is answered. An officer opens a queue scoped to their
division and their wards, and acts on cases. Both are MHA Samadhan. Neither
should ever see the other's screens.

This document is the contract. It describes what exists and is deployed
today, not an aspiration — every endpoint here is live and every behaviour
described has been exercised end to end. Where something is *not* built, it
says so plainly rather than leaving you to discover it.

---

## 1. The two backends

| | Citizen portal | Department workspace |
|---|---|---|
| Host | `https://hacknovate2026.visioncoders.in` | `https://hacknovate26.visioncoders.in` |
| Stack | Node + Express + **PostgreSQL** | React + Express + **SQLite** |
| Identity | A citizen, self-registered | A staff officer, created by an admin |
| Session | JWT, **12 h** | Opaque token, **8 h** |
| Sign-in | mobile + email → OTP | access key + email + password → OTP |
| Registration | Open to the public | **None.** Admin creates accounts |
| Owner | this repo, `app/backend/` | this repo, `govt/` (Yash) |

They are separate processes with separate databases and separate hostnames.
They are joined at exactly one seam: a filed complaint is forwarded to the
department, and the department's progress is mirrored back. Everything else
is independent — which is deliberate, so a fault on the staff side cannot
take down the door citizens file through.

### 1.1 Why the app must not merge them

It is tempting to build one "user" model with a role flag. Do not.

The two portals disagree about what a user *is*. A citizen has a mobile
number, a preferred language and no permissions. An officer has an email, an
access level, a division, a ward list and a permission set the server
recalculates on every request. A single model forces one of them to carry
nulls for the other's fields, and the first time a bug lets a citizen token
reach a staff endpoint you will wish they had been different types.

**Model them as two separate identity types that cannot be assigned to each
other.** See §4.

---

## 2. First run, before any screen

On launch, **before** rendering the start screen, fetch both manifests in
parallel:

```
GET https://hacknovate2026.visioncoders.in/api/mobile/manifest
GET https://hacknovate26.visioncoders.in/api/mobile/manifest
```

Both are public, unauthenticated, and cacheable for a few minutes.

They tell you three things you must not hard-code:

1. **How to sign in** — as a list of fields to render. If a factor is added
   or dropped server-side, the form changes without a Play Store release.
2. **What actually works on this deployment** — voice, translation, assisted
   routing, OTP delivery. Never offer a feature whose capability flag is
   false; a dead button is worse than an absent one.
3. **`apiVersion`** — currently `1`. If it is higher than the app was built
   for, show "please update" rather than guessing at fields you do not know.

Live shape (abridged):

```jsonc
// citizen
{
  "portal": "citizen", "apiVersion": 1,
  "title": "MHA Samadhan",
  "auth": {
    "kind": "citizen", "flow": "otp",
    "steps": [
      { "id": "identify", "endpoint": "POST /api/auth/start",
        "fields": [ { "key": "mobile", "type": "tel", "pattern": "^[6-9][0-9]{9}$", "prefix": "+91" },
                    { "key": "email",  "type": "email", "required": true } ] },
      { "id": "verify", "endpoint": "POST /api/auth/verify",
        "fields": [ { "key": "code", "type": "otp", "length": 6 } ] }
    ],
    "signUp": { "fields": [ "fullName", "mobile", "gender", "email", "consent" ] },
    "session": { "transport": "bearer", "ttlSeconds": 43200 }
  },
  "capabilities": { "voiceInput": true, "translation": true, "assistedRouting": true, ... },
  "languages": [ { "code": "or", "autoDetectable": false }, ... ],   // 14
  "divisions": [ ... ],                                              // 16
  "sla": { "days": 21 }
}
```

```jsonc
// department
{
  "portal": "department", "apiVersion": 1,
  "auth": {
    "kind": "staff", "flow": "key-password-otp",
    "steps": [
      { "id": "credentials", "fields": [ "accessKey", "email", "password" ] },
      { "id": "verify",      "fields": [ "code" ] }
    ],
    "accessKeyRequired": true, "otpRequired": true,
    "selfSignUp": false,
    "session": { "transport": "bearer", "ttlSeconds": 28800 }
  },
  "capabilities": { "translation": true, "textSize": true },
  "languages": [ "en", "hi", ... ]
}
```

> **The access-key field is conditional.** `auth.steps[0].fields` only
> contains `accessKey` when the deployment sets one. Render from the list;
> do not assume it is there, and do not assume it is not.

---

## 3. The start screen

Three doors, and the difference must be unmistakable. An officer who taps
"File a grievance" and an citizen who taps "Officer sign-in" should both
realise instantly.

```
┌──────────────────────────────────────┐
│  भारत सरकार | Government of India    │   ← GOI strip, always
│  गृह मंत्रालय | Ministry of Home…    │
├──────────────────────────────────────┤
│         [ MHA ] MHA Samadhan         │
│   आपकी आवाज़, आपका अधिकार।           │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  File or track a grievance     │  │  → citizen sign-in
│  │  नागरिक · Citizen              │  │
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │  Create a citizen account      │  │  → citizen sign-up
│  └────────────────────────────────┘  │
│                                      │
│  ───────── for officials ─────────   │
│  ┌────────────────────────────────┐  │
│  │  Department sign-in            │  │  → staff sign-in
│  │  Authorised staff only         │  │     (visually distinct:
│  └────────────────────────────────┘  │      dark, no illustration)
│                                      │
│  Text size  A- A A+   Language ▾     │   ← before sign-in, always
└──────────────────────────────────────┘
```

**Text size and language belong on this screen.** Someone who cannot
comfortably read the English interface needs those controls *before* they are
asked to type a mobile number, not after.

Requirements:

- The staff door is styled as a different surface — darker, no illustration,
  an "authorised staff only" line. It is not a third equal option.
- Remember the last door used and pre-select it. Do not auto-navigate; an
  officer sharing a device with a family member should see the choice.
- If `department.manifest` fails to load, still show the citizen doors and
  mark the staff door unavailable. The citizen path must never depend on the
  staff backend being reachable.

---

## 4. Authentication

### 4.1 Citizen sign-in

```
POST {citizen}/api/auth/start
  { "mode": "signin", "mobile": "9876543210", "email": "name@example.com" }
```

The email is a second factor, not decoration: where an account already holds
an address, the one typed must match it. A mismatch and a malformed address
return the **same** message, deliberately — otherwise the endpoint becomes a
way to discover which address an account has.

Response:

```jsonc
{ "ok": true, "mode": "signin",
  "mobile": "+91 98••• ••10",        // masked; show this, you do not have the rest
  "isReturning": true, "name": "Vansh Thakur",
  "expiresAt": "…", "ttlSeconds": 300, "resendAfter": 60,
  "delivered": true, "channel": "email",   // ← where the code actually went
  "deliveryIssue": null }
```

> **`channel` matters.** The code usually arrives by **email**, not SMS,
> because the Twilio account is a trial that refuses numbers it has not been
> shown. Your OTP screen must say *"sent to n****@gmail.com"* when
> `channel == "email"`. Saying "check your SMS" when nothing will arrive is
> the single most likely reason a demo stalls.

Then:

```
POST {citizen}/api/auth/verify
  { "mobile": "9876543210", "code": "123456", "language": "hi" }
→ { "ok": true, "citizen": {...}, "isNew": false, "profileComplete": true,
    "token": "<jwt>", "expiresInSeconds": 43200 }
```

Store `token`. Send `Authorization: Bearer <token>` on every later call.

**Error codes you must handle by name, not by string match:**

| `error` | HTTP | What the app should do |
|---|---|---|
| `no_account` | 404 | Switch to sign-up, **carrying the mobile and email across**, and say only name and gender remain |
| `already_registered` | 409 | Switch to sign-in, carrying the fields |
| `otp_cooldown` | 429 | Disable resend for `retryAfter` seconds |
| `otp_hourly_limit` | 429 | Explain, offer the helpline |
| `otp_incorrect` | 400 | Clear the boxes, keep the challenge, show attempts remaining |
| `otp_expired` / `otp_not_found` | 400 | Send them back to step one |
| `validation_failed` | 422 | `errors[]` is `{field, message}` — attach each to its field |

The `no_account` case is worth care. The web version used to leave people on
a Login form with "no account for this number", which reads as a refusal, and
people retype rather than wait. The app should switch immediately and
pre-fill.

### 4.2 Citizen sign-up

```
POST {citizen}/api/auth/start
  { "mode": "signup", "fullName": "...", "mobile": "...",
    "gender": "<from GET /api/auth/genders>", "email": "...", "consent": true }
```

Then the same `/api/auth/verify`.

**Nothing is created until the code is verified.** The details ride on the
OTP record, not on an account — otherwise anyone could occupy someone else's
mobile number by starting a sign-up they never finish. Your UI should not
imply an account exists before step two completes.

Gender options come from `GET /api/auth/genders` — do not hard-code them, the
server validates against its own list.

### 4.3 Staff sign-in

Three factors, in this order:

```
POST {dept}/api/auth/login
  { "accessKey": "…", "email": "officer@mha.gov.in", "password": "…" }
```

- The **access key** is departmental and shared, issued out of band. It is
  checked *before* the password. Label it clearly as **not** a password, or
  people will type their password into it.
- The reply never says which factor failed — `"Those sign-in details were not
  accepted."` covers all of them. Do not try to be more helpful than the
  server; you would be reconstructing exactly what it is withholding.

Response — **two shapes**, and you must handle both:

```jsonc
// usual: a code was sent
{ "otpRequired": true, "challengeId": "…", "sentTo": "th****@gmail.com",
  "expiresInSeconds": 300, "delivered": true, "channel": "email" }

// when the deployment has no OTP channel configured at all
{ "user": {...}, "role": {...}, "mustChangePassword": false, "token": "…" }
```

The second shape exists because demanding a code that physically cannot be
delivered locks the operator out rather than protecting anything. Branch on
the presence of `token`.

```
POST {dept}/api/auth/login/verify
  { "challengeId": "…", "code": "123456" }
→ { "user": {...}, "role": {...}, "mustChangePassword": true, "token": "…" }
```

**`mustChangePassword` is a hard gate.** Until it is cleared, the only
screens reachable are change-password and sign-out. The server enforces this;
the app must not present a queue it will be refused from.

```
POST {dept}/api/auth/change-password   { "currentPassword": "…", "newPassword": "…" }
```

A code is single-use and a new attempt invalidates any code still in flight —
so "resend" means restarting step one, not re-requesting the same challenge.

### 4.4 Session isolation — the rule that matters most

> **A staff token must never be sent to the citizen API, and a citizen token
> must never be sent to the department API.**

Make this structurally impossible rather than a thing to remember:

- Two Retrofit (or Ktor) instances, each with its own base URL and its own
  auth interceptor reading its own store. Neither can see the other's token.
- Two `DataStore` files — `citizen_session` and `staff_session` — encrypted,
  never a shared "token" key.
- Signing in through one door **clears the other store**. The app holds at
  most one identity at a time. There is no "switch account" that keeps both
  warm; that is how a token ends up on the wrong request.
- Sign-out clears everything and returns to the start screen.

On **401 from either portal**: clear that portal's store, return to the start
screen, and say the session expired. Do not retry, and do not silently
re-authenticate — there is no refresh token on either side.

---

## 5. The internal UI is chosen by the server

This is the heart of "the UI changes according to the login used".

After sign-in, immediately call the session endpoint for whichever portal you
authenticated against:

```
GET {portal}/api/mobile/session      Authorization: Bearer <token>
```

Build the bottom navigation **from `modules`**, in the order given. Do not
hard-code tabs.

### 5.1 Citizen session

```jsonc
{ "portal": "citizen", "apiVersion": 1,
  "identity": { "displayName": "Vansh Thakur", "mobile": "…", "verified": true,
                "language": "hi", "profileComplete": true },
  "modules": [
    { "id": "home",    "label": "Home",          "icon": "home",   "route": "/home" },
    { "id": "file",    "label": "Register",      "icon": "mic",    "route": "/file",
      "requiresProfile": true, "disabledReason": null },
    { "id": "cases",   "label": "My grievances", "icon": "folder", "route": "/cases", "badge": 2 },
    { "id": "track",   "label": "Track",         "icon": "search", "route": "/track" },
    { "id": "alerts",  "label": "Updates",       "icon": "bell",   "route": "/alerts", "badge": 1 },
    { "id": "profile", "label": "Profile",       "icon": "person", "route": "/profile" }
  ],
  "counts": { "filed": 4, "active": 2, "resolved": 1, "pastDue": 0,
              "awaitingDepartment": 0, "unreadAlerts": 1 } }
```

`disabledReason` is not advisory. A citizen without a name and gender cannot
complete a filing — show the tab disabled with that reason rather than
letting them tell their story and fail at the end.

### 5.2 Staff session — five different apps

```jsonc
{ "portal": "department",
  "identity": { "name": "…", "roleName": "Cyber & Information Security Officer",
                "accessLevel": "DIVISION_ADMIN", "scopeType": "DIVISION",
                "divisionId": "CYBER_INFORMATION_SECURITY",
                "scopeLabel": "Cyber & Information Security",
                "mustChangePassword": false },
  "can": { "readTickets": true, "resolve": true, "reroute": true,
           "viewAnalytics": true, "manageStaff": false, "routeOtherCases": false },
  "modules": [ … ],
  "statuses": ["PENDING","UNDER_INVESTIGATION","RESOLVED"] }
```

What each access level gets — derived server-side, after the role's
permissions have been clipped to its ceiling:

| `accessLevel` | Sees | Modules | Notable |
|---|---|---|---|
| `SUPER_ADMIN` | All divisions, all wards | Queue, Analytics, Activity, **Staff & roles**, Account | The only level with staff management |
| `DIVISION_ADMIN` | One division, all its wards | Queue, Analytics, Activity, Account | |
| `L1_RESOLVING_OFFICER` | One division **∩ assigned wards** | Queue, Account | No analytics |
| `APPELLATE_AUTHORITY` | One division, **appealed cases only** | Appeals, Analytics, Activity, Account | Queue is labelled *Appeals*; **cannot reroute** |
| `OTHER_CASE_TRIAGE` | The `OTHER_TRIAGE` queue only | Queue, Account | **Cannot resolve.** Only routes `OTHER` cases onward |

Drive every affordance from `can`:

- `can.resolve == false` → no "Mark resolved", no report field. (Triage.)
- `can.reroute == false` → no "Route to division". (Appellate.)
- `can.routeOtherCases == true` → show the destination picker, excluding
  `OTHER_TRIAGE` itself.
- `can.manageStaff == false` → the Staff tab is absent, not greyed.

Show `scopeLabel` persistently in the app bar. An officer should never be in
doubt about why a case is missing from their queue.

> **None of this is security.** Every route authorises independently and an
> out-of-scope ticket returns 404. This only stops the app drawing a door
> that will be slammed.

---

## 6. Citizen screens

### 6.1 Home

- Counters from `session.counts` — never computed in the app.
- **Recent cases**: `GET /api/grievances?limit=50`, show 4, **See more / See
  less**. Someone checking on a complaint wants to see it, not to learn a
  navigation scheme.
- Each row shows **both** tracking numbers:
  - `tracking.reference` — `MHA-GRV-2026-000071`, ours, issued at filing
  - `tracking.departmentCase` — `MHA-2026-0014`, theirs, what an officer quotes
  Showing one without the other leaves the missing one impossible to look up.
- When `tracking.pendingForward` is true, show *"reaching the department"* —
  not an error. The docket is already valid.
- SLA bar from `sla.daysLeft` / `sla.days`; red past `sla.breached`.

### 6.2 Filing — the conversation

This is the core screen. It is a **state machine driven entirely by the
server**; the app renders what it is told and never decides the next question.

```
POST /api/chat/start { "language": "hi" }
→ { conversationId, step, bot: { text, input }, draft, division, lidCandidates, detected }
```

Then for each turn:

```
POST /api/chat/{id}/message
  { "text": "…", "inputMode": "voice"|"text",
    "spoken": { "locale": "hi-IN", "confidence": 0.93, "candidates": [...] } }
```

The response's `bot.input.kind` tells you what control to render:

| `kind` | Render |
|---|---|
| `narrative` | Free text + microphone |
| `choose_division` | Chips of all divisions, **`other` always last and visually distinct** |
| `confirm_division` | "Yes, <name>" / "No, choose another" |
| `field` | A single input typed by `field.type`; if `input.suggestion` is present, offer it as a chip labelled *"From what you told me — check it is right"* |
| `pincode` | Numeric, 6 digits |
| `district`, `address`, `name` | Text |
| `gender` | Chips from `input.options` |
| `location_pin` | "Share my location" / "Skip" — **both are valid answers** |
| `declaration` | "I declare this is true" / "Not yet" |
| `done` | Enable submit |

Other endpoints in this flow:

```
POST  /api/chat/{id}/division     { "divisionId": "cyber" }
PATCH /api/chat/{id}/draft        { "latitude": …, "longitude": … } | { "skipLocationPin": true }
POST  /api/chat/{id}/declaration  { "accepted": true }
POST  /api/chat/{id}/submit       {}  → 201 { reference, division, sla, spoken }
POST  /api/grievances/conversation/{id}/evidence   multipart "files" (≤5, PDF/JPEG/PNG/WebP/HEIC, 10 MB)
POST  /api/grievances/conversation/{id}/audio      multipart "audio" (the narrative recording)
```

**Conversation history and resume:**

```
GET /api/chat/history   → [ { id, title, step, turns, reference, submitted, updatedAt } ]
GET /api/chat/{id}      → includes `transcript` — replay it to rebuild the screen
```

Keep the active conversation id in the ViewModel. **Changing language must
not start a new conversation** — resume the existing one. That bug cost a
half-written complaint on the web and will again if the app re-calls
`/chat/start` on configuration change.

"Clear recent chats" hides locally (a local id set), **never deletes**. A
grievance interview is a record of what a citizen said to a government
portal; a tidying gesture must not destroy one.

### 6.3 The "How this was understood" panel

Every turn returns `pipeline.steps[]`. Render it. It is the honest answer to
"is this real?" and it is the most persuasive screen in the app:

| `stage` | Show |
|---|---|
| `language-identification` | Language, confidence %, `azure-speech` vs `local-script-analysis`, and `switched`/`previous` when it changed |
| `translation` | Produced, or **skipped with the reason** |
| `classification` | Division, confidence, the exact `matched[]` terms |
| `llm-adjudication` | Whether the model was consulted, what it chose, its `reason`, and whether it agreed with the keywords |
| `field-extraction` | How many fields were pre-filled, how many suggestions were discarded for failing validation |

### 6.4 Tracking

- Signed in: `GET /api/grievances/{reference}` — full record, timeline, evidence.
- Not signed in: `GET /api/grievances/track/{reference}` — **public**, returns
  status and dates only, no complaint text and no personal data. Use this for
  a "track without signing in" entry on the start screen.

---

## 7. Staff screens

### 7.1 Bootstrap

```
GET /api/bootstrap   → { user, role, tickets, wards, roles?, users?, activities? }
```

One call that returns everything already scoped. Prefer it over separate
fetches on cold start; `GET /api/tickets` (max 500) is for refresh.

### 7.2 Queue

Group by `status`; sort overdue first. Each row: `grievanceId`, category,
`slaStatus`, ward, submitted date.

A ticket's `payload` carries `originalRegionalText` and
`translatedEnglishText`. **Show both, original first** — it is the citizen's
own account and the translation is a convenience. Never machine-translate
either in the app; the original is evidence.

Dynamic `details` differ per category. Render from the category, and expect
them to be **absent** for a cross-department ward role — the server strips
sensitive fields for users outside the owning division, and that is correct,
not a bug to work around.

### 7.3 Acting on a case

```
PATCH /api/tickets/{id}   { "status": "UNDER_INVESTIGATION" }
PATCH /api/tickets/{id}   { "status": "RESOLVED", "actionTakenReport": "…" }   // ≤5000 chars
PATCH /api/tickets/{id}   { "routeToDivisionId": "CYBER_INFORMATION_SECURITY" } // triage only
```

- 404 means out of scope, not missing. Say "not in your queue".
- Routing an `OTHER` case **clears `payload.details`** by design and cannot
  target `OTHER_TRIAGE`. Warn before confirming — the follow-up answers that
  were collected do not survive, and the officer should know that.

### 7.4 Analytics and activity

```
GET /api/analytics/summary  → { total, byStatus, bySla, generatedAt }
GET /api/activity           → scoped feed, capped at 50
```

Both require `can.viewAnalytics`. The counts are already scoped — do not
annotate them as national figures.

### 7.5 Staff administration (Super Admin only)

```
GET/POST/PATCH /api/roles
GET/POST/PATCH /api/users
POST /api/users/{id}/reset-password   → { temporaryPassword }   // shown ONCE
```

The temporary password is returned once and never again. Show it in a
dismissible card with a copy action and a clear "this will not be shown
again" warning. Do not log it, do not put it in a crash report.

---

## 8. Voice

Recognition runs **on the device** against Azure Speech, using a short-lived
token from our server. The subscription key never reaches the app.

```
GET /api/speech/token?language=hi&conversationId=123
→ { token, region, candidates: ["hi-IN","en-IN",…], forceLocale: null,
    supported: 14, identifiable: 12, note: "…" }
```

Two paths, and you must implement both:

```kotlin
if (forceLocale != null) {
    // Azure transcribes this language but will NOT identify it. Offering it
    // as a candidate closes the socket with InvalidArgument before a word is
    // heard — which took the microphone out for everyone, not just these
    // speakers. Pin recognition instead.
    config.speechRecognitionLanguage = forceLocale
    recognizer = SpeechRecognizer(config, audioConfig)
} else {
    config.setProperty(PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous")
    val auto = AutoDetectSourceLanguageConfig.fromLanguages(candidates)
    recognizer = SpeechRecognizer(config, auto, audioConfig)
}
```

- `forceLocale` is non-null for **Odia (`or-IN`)** and **Assamese
  (`as-IN`)** — 12 of the 14 are identifiable, those two are not. They lose
  auto-detection, not the microphone.
- `candidates` is **at most 10** — Azure's own ceiling. The server picks
  which ten from the citizen's chosen language and their PIN code's state.
  Do not add to the list.
- Tokens expire in ~10 minutes. Refresh on `canceled`, do not cache for the
  session.
- Capture the audio **in parallel** with recognition (`MediaRecorder`) and
  POST it to `/conversation/{id}/audio`. The SDK streams to Azure and the
  bytes never reach us otherwise, and the schema requires a raw audio path.
- Send the final `locale` back in `spoken.locale` — Azure heard the audio,
  the server only sees a transcript, so Azure's identification wins.

**Spoken replies** are opt-in and remembered, never automatic:

```
POST /api/speech/speak { "text": "…", "language": "hi" }  → audio/mpeg
```

Audio that starts on its own is hostile in a queue or a shared room. Give
each bot message its own play control, and one global toggle, default off.

---

## 9. Languages

14: English, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada,
Malayalam, Punjabi, Odia, Assamese, Urdu, Nepali.

### 9.1 Interface translation

Both portals expose the same contract:

```
POST /api/i18n  { "to": "pa", "texts": ["Dashboard", "Register a grievance", …] }
→ { "translations": { "Dashboard": "ਡੈਸ਼ਬੋਰਡ", … }, "cached": 8, "fetched": 0 }
```

On Android you have real string resources, so **prefer `values-hi/`,
`values-ta/` … for your own strings** and use this endpoint for text that
comes from the server (division names, bot prompts you did not author,
officer reports). Cache per language in `DataStore`; the server caches too,
so the first user of a language pays and the rest do not.

### 9.2 The rule that is easy to get wrong

> **Portal language ≠ conversation language.**

A citizen may read the app in Hindi and speak to the bot in Punjabi. The bot
replies in the language it *heard*, not the one the UI is set to. Never
translate:

- the chat stream,
- a filed complaint or its stored English rendering,
- docket numbers, PIN codes, amounts, ward ids.

Those are evidence, not chrome.

### 9.3 Right-to-left

Urdu is RTL **as text**. Do **not** flip the layout — set per-view text
direction (`View.TEXT_DIRECTION_ANY_RTL` / `android:textDirection="locale"`)
and leave `layoutDirection` alone. Mirroring the whole app is a layout change
nobody asked for when they asked for a translation.

---

## 10. Accessibility

- **Text size** must work. Use `sp` for every text size and honour the system
  font scale; do not cap it. Offer A− / A / A+ in-app that scales a
  multiplier on top, remembered — "A" means *the system setting*, not an
  override of it.
- Minimum touch target 48 dp. People use this under stress.
- Content descriptions on the microphone, the play controls and every icon-only
  action.
- Indic scripts carry marks above and below the baseline: give text generous
  line height and never clip to a fixed height.

---

## 11. Sync model

### 11.1 What is authoritative

| Fact | Owner |
|---|---|
| Citizen identity, conversations, the filed complaint | Citizen portal (Postgres) |
| Ticket lifecycle once forwarded — status, report | **Department** (SQLite) |
| The citizen's docket `MHA-GRV-…` | Citizen portal |
| The department case `MHA-YYYY-NNNN` | Department |

The citizen portal **mirrors** the department's status; it never pushes one
back. The app mirrors the citizen portal. Do not write status anywhere.

### 11.2 Timing — set expectations correctly

A complaint is **accepted before it is forwarded**. On `submit` you get a
docket immediately; `tracking.departmentCase` may be null for a few seconds
or minutes. A retry sweep runs server-side every 5 minutes.

Show "reaching the department" for that window. **Do not show an error** —
nothing has failed, and the docket is already valid.

Department status is pulled by the same sweep, so an officer's action appears
to the citizen within ~5 minutes, not instantly. If you want it sooner, poll
`GET /api/grievances/{reference}` on pull-to-refresh.

### 11.3 Offline

- Cache the manifest, session, case list and case detail in Room. Render from
  cache first, refresh behind it.
- **Never queue a filing offline.** The interview is server-driven and every
  turn depends on the last; a queued complaint would be a half-conversation
  with no docket. Disable the microphone and Send when offline and say so.
- Evidence upload may be retried — it is idempotent per conversation only in
  the sense that duplicates are visible; prefer resumable upload with the
  user's consent rather than silent retry.
- **There is no idempotency key on submit.** A retried submit creates a second
  grievance. Disable the button on first tap and key it to the conversation id.

---

## 12. Errors and limits

Both portals return `{ "error": "<code>", "message": "<human text>" }`. Branch
on `error`, display `message`.

| Limit | Where | Value |
|---|---|---|
| Citizen OTP | per number | 5 / hour, 60 s between, 5 wrong attempts |
| Citizen sign-in | per IP | 20 start / 40 verify per 15 min |
| Staff sign-in | per IP | 300 / 15 min |
| Interface translation | per IP | 30 / min |
| TTS | per session | 40 / min |
| Public intake | per IP | 20 / hour (anonymous) |

On `429`, honour `Retry-After` and say when they can try again. Never
hot-loop a retry.

---

## 13. Security rules for the app

1. Tokens in `EncryptedSharedPreferences` / encrypted `DataStore`. Never in
   plain prefs, never in logs, never in a crash report.
2. **Never log** OTP codes, the access key, temporary passwords, Aadhaar or
   bank details. Strip them from any diagnostic payload.
3. The access key is **typed**, never stored and never remembered. Not in an
   autofill hint, not in a "remember me".
4. `android:allowBackup="false"` — a session and a half-written grievance
   should not land in a cloud backup.
5. HTTPS only; `cleartextTrafficPermitted="false"`. Both hosts have valid
   Let's Encrypt certificates.
6. `FLAG_SECURE` on the OTP screen, the temporary-password card and any
   screen showing a complaint's dynamic details.
7. No analytics SDK on any screen that shows complaint text. The content is a
   citizen's account of a crime.
8. Aadhaar and bank numbers are already masked to last-4 by the server.
   Display what you are given; never ask for the full value.

---

## 14. Suggested structure

```
app/
  core/
    network/        two clients, two interceptors, never shared
    session/        CitizenSession + StaffSession, separate stores
    manifest/       fetch + cache + apiVersion gate
    i18n/           server strings cache
  feature/
    start/          three doors, text size, language
    citizenauth/    sign-in, sign-up, OTP
    staffauth/      access key + password, OTP, forced password change
    citizen/
      home/ file/ cases/ caseDetail/ track/ alerts/ profile/
      file/speech/  Azure SDK, parallel capture, pipeline panel
    staff/
      queue/ caseDetail/ analytics/ activity/ staffAdmin/ account/
  designsystem/     GOI strip, tricolour, Civic Trust tokens, Noto fonts
```

- **Single-activity, Navigation Compose.** Two top-level graphs —
  `citizenGraph` and `staffGraph` — that do not link to each other. The only
  route between them is through the start screen after a sign-out.
- Retrofit + Moshi (or Ktor + kotlinx), Hilt, Room, DataStore, Coil.
- Bundle Noto Sans for Devanagari, Bengali, Tamil, Telugu, Kannada,
  Malayalam, Gujarati, Gurmukhi, Odia and Nastaliq, or Odia and Urdu will
  render as boxes on many devices.

---

## 15. Acceptance checklist

Auth and routing
- [ ] Manifests fetched before the start screen; a dead capability is never offered
- [ ] Citizen sign-in → OTP by **email** → token → citizen graph only
- [ ] Sign-up creates nothing until the code is verified
- [ ] `no_account` switches to sign-up carrying mobile and email
- [ ] Staff sign-in refuses without the access key; failures never name the factor
- [ ] `mustChangePassword` blocks everything but change-password and sign-out
- [ ] Signing in to one portal clears the other's token
- [ ] 401 clears that store and returns to the start screen

Role-shaped UI
- [ ] Bottom nav built from `modules`, never hard-coded
- [ ] Triage sees no "Resolve"; Appellate sees no "Route"
- [ ] `Staff & roles` only for `SUPER_ADMIN`
- [ ] `scopeLabel` always visible in the staff app bar
- [ ] Register tab disabled with `disabledReason` when the profile is incomplete

Filing
- [ ] All 14 languages selectable; Odia and Assamese pin recognition
- [ ] Rotating the device does **not** start a new conversation
- [ ] Changing portal language does **not** restart the interview
- [ ] Narrative audio uploaded alongside recognition
- [ ] `other` offered last and visually distinct; its generated questions render
- [ ] Pipeline panel shows every stage, including skipped ones with reasons
- [ ] Submit disabled after first tap

Tracking and sync
- [ ] Both tracking numbers shown on every case
- [ ] `pendingForward` reads as progress, not failure
- [ ] Department status change appears after refresh
- [ ] Public track works signed out and leaks no complaint text

Accessibility and localisation
- [ ] System font scale honoured to 200 % with no clipping
- [ ] Urdu text RTL, layout **not** mirrored
- [ ] Chat stream and case text never machine-translated
- [ ] Every icon-only control has a content description

---

## 16. What does not exist yet

Say so in the app rather than faking it:

- **No push notifications.** `GET /api/grievances/me/notifications` is a poll.
  FCM would need a token registry on the citizen portal — not built.
- **No citizen appeal submission.** The appellate queue reads
  `payload.appealStatus`, which nothing citizen-facing sets.
- **No evidence on the staff side.** Intake stores URLs and metadata; there is
  no upload, no object storage and no signed-URL proxy. Staff see filenames.
- **No real-time.** No websocket on either portal; everything is request/response.
- **No SLA recalculation job.** `slaStatus` is set at intake and does not
  re-evaluate on a timer.
- **No idempotency on intake.** A retried forward creates a second case.

---

*Both backends are deployed and all behaviour above has been exercised
end to end: 109 citizen checks, 57 department RBAC scenarios, and a full
round trip from a filed complaint through an officer's action back to the
citizen's timeline. Where this document and the running code disagree, the
code is right — and that is a bug in this document.*
