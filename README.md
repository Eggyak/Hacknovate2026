# MHA Samadhan

A multilingual, voice-first grievance portal for the Ministry of Home Affairs.
A citizen describes a problem by speaking or typing in any of **14 Indian
languages**; the system identifies the language, routes the complaint to the
correct MHA division, collects the evidence that division legally requires,
and tracks it against a 21-day statutory deadline.

Live at **https://hacknovate2026.visioncoders.in**

## What is actually real

PS3 asks teams to be upfront about what is a real NLP pipeline and what is a
scripted demo. Concretely:

| Stage | Implementation | Real? |
|---|---|---|
| Speech recognition + language ID | Azure Speech, continuous LID, in-browser over an ephemeral token | Real cloud ASR |
| Typed language detection | Local Unicode-script analysis + marker lexicons | Real, runs offline |
| Translation to English | Azure Translator | Real when a key is set; **skipped and labelled** when not |
| Division routing | Weighted multilingual lexicon over 15 divisions | Real, deterministic, auditable |
| Dialogue | Deterministic state machine over a stored draft | Not an LLM, by choice |

Every response from the interview carries a `pipeline` block naming which
component ran, what it decided and on what evidence. The UI renders it, so the
routing decision can be inspected rather than taken on trust. When a stage
cannot run it says so instead of going quiet.

**Routing never depends on translation.** The lexicons are written in each
language's own script, so a Malayalam complaint routes correctly with no
translation key configured at all.

### The 14 languages

English, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam,
Punjabi, Odia, Assamese, Urdu, Nepali — each verified against a real Azure
neural voice and a real speech-to-text locale.

Azure's continuous language identification evaluates at most **10** candidate
locales per utterance, and we support 14. The server narrows the field per
citizen: the language they chose, English and Hindi as link languages, then the
languages spoken where their PIN code is. This is stated in the UI rather than
hidden.

## Layout

```
app/backend/
  src/data/        languages, 15 MHA divisions + their required fields, states, phrases
  src/services/    language detection, classification, Azure Speech, translation,
                   OTP, the interview state machine, grievance records
  src/routes/      auth, chat, speech, grievances
  migrations/      schema
  public/          the citizen portal (no build step)
  test/            language detection and routing tests
docker-compose.yml  API + its own Postgres, isolated from other stacks
n8n/                the OTP delivery workflow
```

## Running it

```bash
cp .env.example .env     # fill in secrets
docker compose up -d --build
```

`/api/health` reports each dependency separately, so a missing credential is
visible rather than silent.

## Tests

```bash
cd app/backend && node --test test/
```

Covers all 14 languages end to end for detection, and 20 complaints across 10+
languages for routing into all 15 divisions.
