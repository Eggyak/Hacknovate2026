-- ---------------------------------------------------------------------------
-- Cancelling a callback.
--
-- A call that is queued, or ringing, or already connected, needs a way to be
-- stopped by the person it is being made to. The status CHECK was written
-- before there was one, so 'cancelled' has to be added to it - a constraint
-- that silently rejects the new state would turn the stop button into an
-- error toast.
--
-- Dropping and re-adding is the only way to change a CHECK in Postgres. It is
-- safe here: the set of allowed values only grows, so no existing row can
-- fail the new constraint.
-- ---------------------------------------------------------------------------

ALTER TABLE call_requests DROP CONSTRAINT IF EXISTS call_requests_status_check;

ALTER TABLE call_requests
  ADD CONSTRAINT call_requests_status_check
  CHECK (status IN ('queued','placed','answered','failed','expired','cancelled'));

-- When it was stopped, and by whom it was asked to stop. Kept because "the
-- citizen hung up on us" and "the line failed" look identical in a status
-- column alone, and only one of them is a problem worth chasing.
ALTER TABLE call_requests ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
