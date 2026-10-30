-- An unlisted complaint is interviewed with questions written for it rather
-- than a fixed statutory field list, so the questions have to be stored
-- alongside the answers. Without them `dynamic_details` is a map of opaque
-- keys and the record cannot be read back by anyone - citizen or officer.
ALTER TABLE grievances ADD COLUMN IF NOT EXISTS dynamic_labels JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Conversations are now listed as chat history, newest first, and a finished
-- one is still worth showing.
CREATE INDEX IF NOT EXISTS conversations_recent_idx
  ON conversations (citizen_id, updated_at DESC);
