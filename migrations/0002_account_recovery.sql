CREATE TABLE account_recovery_codes (
  code_digest TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at_utc TEXT NOT NULL,
  used_at_utc TEXT,
  revoked_at_utc TEXT
);
CREATE INDEX account_recovery_codes_user_idx
  ON account_recovery_codes(user_id, created_at_utc);
CREATE UNIQUE INDEX account_recovery_codes_one_active_per_user
  ON account_recovery_codes(user_id)
  WHERE used_at_utc IS NULL AND revoked_at_utc IS NULL;

CREATE TABLE account_security_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  subject_user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('recovery_code_issued', 'password_recovered', 'guardian_access_reset')),
  created_at_utc TEXT NOT NULL
);
CREATE INDEX account_security_events_subject_time_idx
  ON account_security_events(subject_user_id, created_at_utc);

CREATE TRIGGER account_security_events_no_update
BEFORE UPDATE ON account_security_events
BEGIN
  SELECT RAISE(ABORT, 'account security events are immutable');
END;

CREATE TRIGGER account_security_events_no_delete
BEFORE DELETE ON account_security_events
BEGIN
  SELECT RAISE(ABORT, 'account security events are immutable');
END;
