-- Core Features, version 1.
--
-- Scoped against the document's own "Recommended MVP (Version 1)" rather than
-- its full brainstorm. Diffing that MVP against what was already built left
-- exactly one gap - citizen feedback - so this adds that and the nearby
-- features that make the same data useful to all three surfaces: the citizen
-- app, the citizen web portal, and the department workspace.
--
-- Deliberately NOT here, because they need infrastructure this project does
-- not have and a half-built version is worse than an honest absence:
-- livestreaming, video hearings, DSC signing, bank restitution, social-media
-- import, and the predictive analytics that would need years of history to
-- mean anything.

-- ---------------------------------------------------------------------------
-- Citizen satisfaction. The one MVP item that was missing.
--
-- Recorded only after the case is resolved, and separately from the status so
-- a bad rating can never be mistaken for the case reopening. A rating is the
-- citizen's verdict on the service; the status is the department's record of
-- the work. They are different claims and must not overwrite each other.
-- ---------------------------------------------------------------------------
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS satisfaction_rating  SMALLINT
  CHECK (satisfaction_rating IS NULL OR satisfaction_rating BETWEEN 1 AND 5);
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS satisfaction_comment TEXT;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS satisfaction_at      TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Anonymous filing.
--
-- `anonymous` hides the citizen from anything PUBLIC - the map, a cluster, a
-- comment thread. It does NOT hide them from the handling department: a
-- grievance with no identifiable complainant cannot be investigated, and
-- promising otherwise would be a lie told to someone reporting a crime.
-- The distinction is written down here because it is the kind of thing that
-- gets quietly misread later.
-- ---------------------------------------------------------------------------
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- Escalation. A case past its statutory deadline is raised a level rather
-- than simply going red on a dashboard nobody is accountable for.
-- ---------------------------------------------------------------------------
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS escalation_level SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS escalated_at     TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Priority, as a stored band rather than a boolean.
--
-- `priority` already existed as normal/high. The document asks for four
-- bands, and the classifier already detects threats to life, so the column
-- widens rather than a new one appearing beside it.
-- ---------------------------------------------------------------------------
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS priority_score SMALLINT NOT NULL DEFAULT 2;
COMMENT ON COLUMN grievances.priority_score IS '4 critical, 3 high, 2 medium, 1 low';

-- ---------------------------------------------------------------------------
-- Duplicate grouping.
--
-- Many citizens reporting one burst water main should be one thing a
-- department can see, not forty things it has to read. A cluster groups them
-- WITHOUT merging: every grievance keeps its own docket, its own SLA and its
-- own complainant, because each of those people is separately entitled to an
-- answer. The cluster is a lens over them, never a replacement.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grievance_clusters (
    id           BIGSERIAL PRIMARY KEY,
    division_id  VARCHAR(40),
    pincode      VARCHAR(6),
    signature    TEXT        NOT NULL,
    title        TEXT,
    member_count INTEGER     NOT NULL DEFAULT 0,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS clusters_signature_idx
  ON grievance_clusters (division_id, pincode, signature);

ALTER TABLE grievances ADD COLUMN IF NOT EXISTS cluster_id BIGINT
  REFERENCES grievance_clusters (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS grievances_cluster_idx ON grievances (cluster_id);

-- ---------------------------------------------------------------------------
-- Support ("me too"), instead of filing the same thing again.
--
-- One per citizen per grievance, enforced by the key rather than by the
-- application - a vote count that can be inflated by retrying a request is
-- not evidence of anything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grievance_supports (
    grievance_id BIGINT      NOT NULL REFERENCES grievances (id) ON DELETE CASCADE,
    citizen_id   BIGINT      NOT NULL REFERENCES citizens (id)   ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (grievance_id, citizen_id)
);

-- ---------------------------------------------------------------------------
-- The conversation after filing: the citizen adds what has changed, the
-- department answers.
--
-- `author_kind` is 'citizen' or 'department'. An officer's reply is written
-- through the department workspace and mirrored here, so the citizen sees one
-- thread rather than having to look in two places.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grievance_comments (
    id           BIGSERIAL PRIMARY KEY,
    grievance_id BIGINT      NOT NULL REFERENCES grievances (id) ON DELETE CASCADE,
    author_kind  VARCHAR(16) NOT NULL CHECK (author_kind IN ('citizen','department')),
    author_name  TEXT,
    body         TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS comments_grievance_idx ON grievance_comments (grievance_id, created_at);

-- ---------------------------------------------------------------------------
-- Response-time monitoring.
--
-- Derived from the event trail rather than stored as a duration, so it can
-- never disagree with the timeline a citizen is shown. These two columns are
-- a cache of that derivation, filled when the case moves.
-- ---------------------------------------------------------------------------
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS first_response_at    TIMESTAMPTZ;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS resolution_seconds   INTEGER;

-- The document's lifecycle has Assigned between Under Review and In Progress.
-- The CHECK lives in application code (services/grievances.js STATUSES), so
-- nothing to alter here - this comment records why the enum grew.
