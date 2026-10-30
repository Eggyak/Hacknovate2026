-- A complaint is accepted by us and then forwarded to the department
-- workspace. Those are two separate facts and the record keeps both: the
-- citizen's docket is ours and is issued the moment they declare the
-- complaint true, while the department's case id arrives later, or not at
-- all if their workspace is down.
--
-- Keeping the failure reason matters as much as the success. A complaint
-- that never reached a desk and nobody noticed is the worst outcome this
-- system has, so an unsynced row is visible and retryable rather than
-- silently equal to a synced one.
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS govt_ticket_id     TEXT;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS govt_grievance_id  TEXT;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS govt_synced_at     TIMESTAMPTZ;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS govt_sync_error    TEXT;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS govt_status        TEXT;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS govt_status_at     TIMESTAMPTZ;
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS govt_report        TEXT;

CREATE INDEX IF NOT EXISTS grievances_unsynced_idx
  ON grievances (submitted_at) WHERE govt_synced_at IS NULL;
