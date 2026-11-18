ALTER TABLE users ADD COLUMN login_code TEXT;
CREATE UNIQUE INDEX users_login_code_unique ON users(login_code) WHERE login_code IS NOT NULL;
CREATE UNIQUE INDEX users_single_provider ON users(role) WHERE role = 'provider';

UPDATE users SET login_code = lower(hex(randomblob(8))) WHERE role = 'guardian';

CREATE TABLE guardian_pin_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  pin_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  kdf_name TEXT NOT NULL,
  kdf_parameters_json TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE guardian_enrollment_codes (
  code_digest TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at_utc TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL,
  used_at_utc TEXT,
  revoked_at_utc TEXT
);
CREATE INDEX guardian_enrollment_codes_user_idx
  ON guardian_enrollment_codes(user_id, created_at_utc);
CREATE UNIQUE INDEX guardian_enrollment_codes_one_active_per_user
  ON guardian_enrollment_codes(user_id)
  WHERE used_at_utc IS NULL AND revoked_at_utc IS NULL;

CREATE TABLE provider_recovery (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  phrase_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  kdf_name TEXT NOT NULL,
  kdf_parameters_json TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  acknowledged_at_utc TEXT
);

CREATE TABLE security_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  subject_user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
CREATE INDEX security_audit_subject_time_idx
  ON security_audit_events(subject_user_id, created_at_utc);
CREATE TRIGGER security_audit_events_no_update
BEFORE UPDATE ON security_audit_events BEGIN
  SELECT RAISE(ABORT, 'security audit events are immutable');
END;
CREATE TRIGGER security_audit_events_no_delete
BEFORE DELETE ON security_audit_events BEGIN
  SELECT RAISE(ABORT, 'security audit events are immutable');
END;

ALTER TABLE sessions ADD COLUMN absolute_expires_at_utc TEXT;
UPDATE sessions SET absolute_expires_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', created_at_utc, '+90 days');
UPDATE sessions SET expires_at_utc = CASE
  WHEN expires_at_utc < absolute_expires_at_utc THEN expires_at_utc
  ELSE absolute_expires_at_utc END;
UPDATE sessions SET revoked_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE user_id IN (SELECT id FROM users WHERE role = 'guardian') AND revoked_at_utc IS NULL;
DELETE FROM credentials WHERE user_id IN (SELECT id FROM users WHERE role = 'guardian');
UPDATE account_recovery_codes SET revoked_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE user_id IN (SELECT id FROM users WHERE role = 'guardian')
    AND revoked_at_utc IS NULL AND used_at_utc IS NULL;
