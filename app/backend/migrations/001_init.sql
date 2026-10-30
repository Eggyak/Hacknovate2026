-- MHA Samadhan - initial schema.
--
-- Mirrors "MHA Grievance Bot - Data Schema & Workflow Requirements" section 1
-- (common base fields) and section 2 (per-division dynamic details).
--
-- Dynamic details are JSONB rather than 15 sparse tables: the division decides
-- which keys are required, the application validates against divisions.js, and
-- a new division becomes a data change instead of a migration.

CREATE TABLE IF NOT EXISTS citizens (
    id                  BIGSERIAL PRIMARY KEY,
    mobile              VARCHAR(15)  NOT NULL UNIQUE,
    mobile_verified     BOOLEAN      NOT NULL DEFAULT FALSE,
    full_name           TEXT,
    gender              TEXT,
    email               TEXT,
    preferred_language  VARCHAR(8)   NOT NULL DEFAULT 'en',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One-time passcodes. The code itself is never stored, only a salted hash,
-- so a database leak cannot be replayed into account takeover.
CREATE TABLE IF NOT EXISTS otp_codes (
    id            BIGSERIAL PRIMARY KEY,
    mobile        VARCHAR(15)  NOT NULL,
    code_hash     TEXT         NOT NULL,
    purpose       VARCHAR(24)  NOT NULL DEFAULT 'login',
    attempts      INTEGER      NOT NULL DEFAULT 0,
    expires_at    TIMESTAMPTZ  NOT NULL,
    consumed_at   TIMESTAMPTZ,
    delivery      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS otp_codes_mobile_idx ON otp_codes (mobile, created_at DESC);

CREATE TABLE IF NOT EXISTS grievances (
    id                        BIGSERIAL PRIMARY KEY,
    reference_id              VARCHAR(32)  NOT NULL UNIQUE,
    citizen_id                BIGINT       NOT NULL REFERENCES citizens (id) ON DELETE CASCADE,

    -- Routing
    division_id               VARCHAR(40),
    classification_confidence NUMERIC(4,2) NOT NULL DEFAULT 0,
    classification_method     TEXT,
    classification_evidence   JSONB        NOT NULL DEFAULT '[]'::jsonb,
    priority                  VARCHAR(12)  NOT NULL DEFAULT 'normal',

    -- Core payload
    original_text             TEXT         NOT NULL,
    translated_text           TEXT,
    translation_provider      TEXT,
    audio_path                TEXT,
    subject                   TEXT,

    -- Language
    detected_language         VARCHAR(8),
    detected_locale           VARCHAR(16),
    language_confidence       NUMERIC(4,2) NOT NULL DEFAULT 0,
    language_method           TEXT,
    input_mode                VARCHAR(10)  NOT NULL DEFAULT 'text',

    -- Location
    pincode                   VARCHAR(6),
    state                     TEXT,
    district                  TEXT,
    address                   TEXT,
    latitude                  NUMERIC(9,6),
    longitude                 NUMERIC(9,6),

    -- Division-specific incident details, validated against divisions.js
    dynamic_details           JSONB        NOT NULL DEFAULT '{}'::jsonb,

    -- Compliance
    declaration_truth         BOOLEAN      NOT NULL DEFAULT FALSE,

    -- Lifecycle
    status                    VARCHAR(24)  NOT NULL DEFAULT 'submitted',
    submitted_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    sla_deadline              TIMESTAMPTZ  NOT NULL,
    closed_at                 TIMESTAMPTZ,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS grievances_citizen_idx ON grievances (citizen_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS grievances_status_idx  ON grievances (status);
CREATE INDEX IF NOT EXISTS grievances_division_idx ON grievances (division_id);

CREATE TABLE IF NOT EXISTS grievance_attachments (
    id            BIGSERIAL PRIMARY KEY,
    grievance_id  BIGINT       NOT NULL REFERENCES grievances (id) ON DELETE CASCADE,
    kind          VARCHAR(16)  NOT NULL DEFAULT 'evidence',
    original_name TEXT         NOT NULL,
    stored_name   TEXT         NOT NULL,
    mime_type     TEXT         NOT NULL,
    size_bytes    BIGINT       NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attachments_grievance_idx ON grievance_attachments (grievance_id);

-- The end-to-end tracker. Every status change appends a row; nothing is
-- updated in place, so the timeline a citizen sees is the real audit trail.
CREATE TABLE IF NOT EXISTS grievance_events (
    id            BIGSERIAL PRIMARY KEY,
    grievance_id  BIGINT       NOT NULL REFERENCES grievances (id) ON DELETE CASCADE,
    status        VARCHAR(24)  NOT NULL,
    note          TEXT,
    actor         VARCHAR(40)  NOT NULL DEFAULT 'system',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_grievance_idx ON grievance_events (grievance_id, created_at);

-- A conversation in progress. The bot is a state machine over this row, so a
-- citizen can close the tab and come back to a half-finished complaint.
CREATE TABLE IF NOT EXISTS conversations (
    id            BIGSERIAL PRIMARY KEY,
    citizen_id    BIGINT       NOT NULL REFERENCES citizens (id) ON DELETE CASCADE,
    step          VARCHAR(40)  NOT NULL DEFAULT 'narrative',
    language      VARCHAR(8)   NOT NULL DEFAULT 'en',
    draft         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    transcript    JSONB        NOT NULL DEFAULT '[]'::jsonb,
    grievance_id  BIGINT       REFERENCES grievances (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conversations_citizen_idx ON conversations (citizen_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id            BIGSERIAL PRIMARY KEY,
    citizen_id    BIGINT       NOT NULL REFERENCES citizens (id) ON DELETE CASCADE,
    grievance_id  BIGINT       REFERENCES grievances (id) ON DELETE CASCADE,
    title         TEXT         NOT NULL,
    body          TEXT,
    read_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_citizen_idx ON notifications (citizen_id, created_at DESC);

-- Per-year docket sequence, so reference ids read MHA-GRV-2026-000001.
CREATE TABLE IF NOT EXISTS reference_counters (
    year      INTEGER PRIMARY KEY,
    last_value BIGINT NOT NULL DEFAULT 0
);
