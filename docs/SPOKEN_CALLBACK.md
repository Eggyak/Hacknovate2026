# Spoken status callback

A citizen picks one of the fourteen languages, presses **Call me now**, and
the system rings the number already on their account. A synthesised voice
reads back where their most recent grievance has got to.

The portal already reads in fourteen languages and the bot already speaks
them — but all of that still assumes a screen and a reader. A grievance
system whose *status* is only legible to people who can read it has the
same gap as one that only accepts written English, moved one step later.

## What it says, and what it does not

It reads the reference, the division, the state of the case and the due
date. The reference is spelled out digit by digit, because every speech
engine reads `2026` as "two thousand and twenty-six" and that is useless to
somebody writing it down.

It never reads the complaint text. That is the citizen's own account of
something that may be sensitive, and a telephone may be on speakerphone in
a room with other people in it.

There is **no field to type a number into**. It rings the number on the
account and nothing else, so the feature cannot be pointed at a third
party. The number is snapshotted onto the job when the call is requested,
so a profile edit mid-queue cannot redirect a call that is already owed.

The script is fixed at request time for the same reason: a status that
changes in the minutes before the phone rings should not change what was
promised.

## Shape

```
citizen  ──POST /api/calls/request──▶  portal
                                        │  queues call_requests row,
                                        │  writes the English script
                                        ▼
                               POST  N8N_CALLBACK_WEBHOOK_URL
                                        │  { token, to, language, twimlUrl }
                                        ▼
                                   n8n ──▶ Twilio: dial `to`,
                                            TwiML = Redirect ▶ twimlUrl
                                        ▼
               Twilio ──GET /api/calls/twiml/:token──▶ portal
                                        │  <Play> the audio route, twice
                                        ▼
               Twilio ──GET /api/calls/audio/:token──▶ portal
                                        │  Azure neural voice, translated
                                        ▼
                                   citizen hears it
```

`<Play>` rather than Twilio's `<Say>`: their voices do not cover these
fourteen languages, and the ones they do cover read an Indian docket number
with an accent that makes it hard to follow.

The workflow redirects rather than carrying inline TwiML, so nothing about
anybody's grievance passes through n8n — it dials a number and hands the
call back to the portal.

## Protection

Twilio fetches TwiML over the public internet with no session, so those two
routes are gated on a token that is random, single-purpose and expires
within the hour. What a leaked token yields is a status reading — no name,
no number, no complaint text.

`/api/calls/request` needs a citizen session and is capped twice: three
calls an hour per account, in the service, and twenty an hour per IP in the
route, so one machine cannot queue calls across many accounts.

`/api/calls/status` is for the workflow and is gated on
`CALLBACK_SHARED_SECRET`.

## Wiring it up

Nothing below is set by this repository and none of it is in git.

### Why the workflow carries no configuration

This n8n runs with `N8N_RUNNERS_ENABLED=true`. With task runners on, n8n
blocks `$env` inside expressions — a node that reaches for one does not
error loudly, it just produces nothing, and a *gate* built that way stops
gating. The first version of this workflow had exactly that bug: an IF node
comparing a header against `$env.CALLBACK_SHARED_SECRET`, which on this
instance silently did neither.

So the workflow reads nothing from its environment. Every value — the
number to dial, the number to dial from, the TwiML URL, the status URL —
arrives in the request body from the portal, and the gate is n8n's own
**Header Auth**, which is enforced before any node runs.

That leaves exactly two things to configure in n8n, both credentials.

### 1. A Twilio number

Use whichever account you like, but the Saarthi 2.0 project's credentials
are not read or reused here, and its number should not be repointed — an
incoming webhook changed on a shared number is how you break that pipeline.
Provision a separate number, or use the same account with a *different*
number and a *separate* n8n credential.

On a Twilio trial, outbound calls only connect to **verified** numbers. Add
the test phone under Verified Caller IDs first, or the call fails `21219`
and the citizen simply never hears a ring.

### 2. In n8n

Import `ops/n8n/mha-status-callback.json`, then open the workflow and
attach two credentials:

| Node | Credential | Value |
|---|---|---|
| Callback requested | **Header Auth** | name `x-callback-secret`, value = your secret |
| Place the call | **Twilio API** | the account the number belongs to |

Activate it. `import:workflow` leaves a workflow **deactivated**, so from
the CLI follow it with `n8n update:workflow --id=<id> --active=true` and
restart n8n.

### 3. In `/opt/stacks/mha-samadhan/.env`

Mode 600, never in git:

```
N8N_CALLBACK_WEBHOOK_URL=http://n8n-kmar-n8n-1:5678/webhook/mha-status-callback
CALLBACK_SHARED_SECRET=<the same secret as the Header Auth credential>
TWILIO_FROM_NUMBER=+1XXXXXXXXXX
```

The container name rather than the public hostname: `mha-api` is already on
the `n8n` network, and going out to the internet and back in to reach a
service one bridge away is slower and fails differently.

Then `docker compose up -d mha-api`.

## Checking it

Until `N8N_CALLBACK_WEBHOOK_URL` is set, the capability reports false, the
dashboard card says so in words, and `/api/calls/request` answers 503. That
is the intended state of a deployment with no telephony, not a bug.

```bash
# Is it switched on?
curl -s $PUBLIC/api/mobile/manifest | grep -o '"spokenCallback":[a-z]*'

# The two public routes exist and refuse a bad token
curl -s -o /dev/null -w '%{http_code}\n' $PUBLIC/api/calls/audio/nonsense   # 404
curl -s $PUBLIC/api/calls/twiml/nonsense                                    # spoken refusal
```

A bad token yields a *spoken* refusal rather than a 404 on the TwiML route,
because Twilio reads the response body down the line and an error page
played to a caller is silence.
