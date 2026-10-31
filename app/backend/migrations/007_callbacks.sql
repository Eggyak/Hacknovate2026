-- ---------------------------------------------------------------------------
-- Spoken status callbacks.
--
-- A citizen who cannot read the dashboard can ask to be told. They pick a
-- language, the system rings their own registered number, and a synthesised
-- voice reads back the state of their most recent grievance.
--
-- The row is a job, not a transcript. It holds what to say and who to say it
-- to, and it is the only thing a public TwiML request is allowed to resolve -
-- which is why the token is here and not derived from the citizen's id.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS call_requests (
    id            BIGSERIAL    PRIMARY KEY,
    citizen_id    BIGINT       NOT NULL REFERENCES citizens (id) ON DELETE CASCADE,

    -- Unguessable, and the only credential the telephony side ever carries.
    -- Twilio fetches TwiML over the public internet with no session, so this
    -- stands in for one.
    token         TEXT         NOT NULL UNIQUE,

    language      VARCHAR(8)   NOT NULL,

    -- The number rung, copied at request time. Reading it live would mean a
    -- profile edit mid-queue could redirect a call to a different phone.
    mobile        VARCHAR(16)  NOT NULL,

    -- What the call is about, snapshotted for the same reason. A status that
    -- changes between the request and the call should not silently change
    -- what was promised; the call says what was true when it was asked for.
    reference     VARCHAR(32),
    script_en     TEXT         NOT NULL,

    status        VARCHAR(16)  NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','placed','answered','failed','expired')),
    provider_sid  TEXT,
    failure       TEXT,

    requested_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Short: a callback nobody placed within the hour is stale, and an
    -- indefinitely valid token on a public endpoint is a standing invitation.
    expires_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
    answered_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_call_requests_citizen ON call_requests (citizen_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_requests_status  ON call_requests (status) WHERE status = 'queued';
