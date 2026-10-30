-- Sign-up collects a name, gender and email BEFORE the number is verified,
-- so those details have to survive the round trip to the citizen's phone.
--
-- They are parked on the OTP row rather than written to `citizens`, because
-- an unverified number must not create an account: otherwise anyone could
-- occupy someone else's mobile number by starting a sign-up they never finish.
-- The row is consumed on verification and swept with the rest after 24 hours.
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Sign-in asks for the email alongside the number, so it needs to be findable.
CREATE INDEX IF NOT EXISTS citizens_email_idx ON citizens (lower(email));
