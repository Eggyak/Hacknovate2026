# Operations

## Where it runs

| | |
|---|---|
| URL | https://hacknovate2026.visioncoders.in |
| Host | 187.127.191.13 (`srv1804200`) |
| Stack | `/opt/stacks/mha-samadhan` |
| Containers | `mha-api` (127.0.0.1:8120), `mha-db` (Postgres 16) |
| Routing | Traefik, `/opt/stacks/traefik/dynamic/mha-samadhan.yml` |
| Secrets | `/opt/stacks/mha-samadhan/.env`, mode 600, never in git |

`mha-api` joins three networks: its own, `edge` (so Traefik can reach it) and
`n8n-kmar_default` (so it can POST to the OTP webhook by container name).

## Deploying a change

```bash
cd /opt/stacks/mha-samadhan
git fetch origin && git reset --hard origin/vansh
docker compose up -d --build mha-api
docker exec mha-api node test/e2e.js
```

The e2e suite creates and deletes its own citizens, so it is safe to run
against the live stack. It files real complaints in Hindi and Tamil and
asserts on what lands in the database.

## Checking health

`GET /api/health` reports each dependency separately:

```json
{"dependencies":{"database":{"ok":true},"speech":{"ok":true,"region":"eastus"},
 "translation":{"ok":false,"reason":"not_configured"}}}
```

A missing credential degrades one feature and says so. It never falls back to
something that pretends to work.

## The two Azure resources

The key currently configured is a **Speech-only** resource. It covers
speech-to-text and text-to-speech. It does **not** cover translation — Azure
Translator is a separate resource with its own key, and a Speech key returns
401 against it.

To add English renderings of complaints:

1. Create an **Azure AI Translator** resource (the free F0 tier allows
   2M characters a month, which is far more than this needs).
2. Put its key and region in `.env` as `AZURE_TRANSLATOR_KEY` and
   `AZURE_TRANSLATOR_REGION`.
3. `docker compose up -d mha-api`

Nothing else changes. Routing already works without it.

### Fast Transcription quota

The Speech resource's Fast Transcription quota is exhausted and returns 429.
This does not affect the portal: live microphone capture runs in the browser
against a short-lived token and uses the **real-time** quota, which is
healthy. Only the `/api/speech/transcribe` file-upload fallback is affected,
and it reports the quota failure explicitly.

## OTP delivery

The portal generates, hashes, expires and rate-limits the code. n8n delivers
it. The workflow is `MHA_Samadhan_OTP` (`MHASamadhanOTP1`), webhook
`mha/otp`, cloned from the pattern already running on this box and reusing its
Twilio credential **by id** without modifying it.

To reinstall or rotate the key:

```bash
bash /opt/stacks/mha-samadhan/n8n/install-otp-workflow.sh
```

It substitutes the key from `.env`, shreds the plaintext copy, restarts n8n so
the webhook registers, and restarts the API.

**After any n8n restart, confirm the other workflows came back:**

```bash
docker exec n8n-kmar-n8n-1 n8n list:workflow --active=true
```

There were 14 active workflows before this project; there should be 15 now.

**Email is the primary channel.** A Twilio trial account silently refuses
every number it has not been shown beforehand, which makes SMS useless for a
citizen signing in for the first time. Both sign-up and sign-in collect an
email address, so the workflow sends the code by email (reusing the SMTP
credential already on the box) and falls back to SMS only when no address is
available or the email fails. The response names the channel that carried it,
and the OTP screen tells the citizen where to look.

Twilio still works for numbers verified in its console, and nothing has to
change if the account is later upgraded.

## Never do this

```
docker exec mha-db psql -U mha -d mha_samadhan -c "DELETE FROM citizens"
```

`citizens` cascades to `grievances`, so this erases every real complaint on
the box along with the accounts that filed them. Both test suites create and
delete only their own rows, so there is never a reason to run a blanket
delete after them. If test data does need clearing, delete by the numbers the
suites use (`90000000xx`), never the whole table.

## Backups

```bash
docker exec mha-db pg_dump -U mha mha_samadhan | gzip > /opt/backups/mha_$(date +%F).sql.gz
```

Evidence files live in the `mha-uploads` volume, not in the database.

## What is stored, and what is not

Aadhaar and bank account numbers are masked to their last four digits
**before** they are written — the full value never reaches the database.
Grievance text is stored in the citizen's own script.

Public docket tracking (`/api/grievances/track/:ref`) deliberately returns
only status and dates: no complaint text, no personal data, no identifiers.
