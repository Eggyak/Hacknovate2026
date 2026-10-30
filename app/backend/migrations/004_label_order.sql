-- dynamic_labels was a JSONB object, and JSONB normalises key order - so the
-- sequence a citizen was actually asked in was lost the moment it was stored,
-- and the record read back as a jumble. It is an ordered array now.
--
-- Existing rows are converted rather than dropped. Their original order is
-- already gone, so this recovers the pairs without claiming to recover the
-- sequence.
UPDATE grievances
   SET dynamic_labels = COALESCE(
         (SELECT jsonb_agg(jsonb_build_object('key', k, 'label', v))
            FROM jsonb_each_text(dynamic_labels) AS t(k, v)),
         '[]'::jsonb)
 WHERE jsonb_typeof(dynamic_labels) = 'object';

ALTER TABLE grievances ALTER COLUMN dynamic_labels SET DEFAULT '[]'::jsonb;
