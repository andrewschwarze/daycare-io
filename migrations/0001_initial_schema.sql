PRAGMA foreign_keys = ON;

CREATE TABLE children (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at_utc TEXT NOT NULL,
  deactivated_at_utc TEXT
);

CREATE TABLE guardians (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at_utc TEXT NOT NULL,
  deactivated_at_utc TEXT
);

CREATE TABLE guardian_children (
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at_utc TEXT NOT NULL,
  deactivated_at_utc TEXT,
  PRIMARY KEY (guardian_id, child_id)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  guardian_id TEXT UNIQUE REFERENCES guardians(id),
  role TEXT NOT NULL CHECK (role IN ('provider', 'guardian')),
  display_name TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_at_utc TEXT NOT NULL,
  deactivated_at_utc TEXT,
  CHECK ((role = 'provider' AND guardian_id IS NULL) OR
         (role = 'guardian' AND guardian_id IS NOT NULL))
);

CREATE TABLE credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  kdf_name TEXT NOT NULL,
  kdf_parameters_json TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE sessions (
  token_digest TEXT PRIMARY KEY,
  csrf_digest TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at_utc TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL,
  revoked_at_utc TEXT
);
CREATE INDEX sessions_user_expiry_idx ON sessions(user_id, expires_at_utc);

CREATE TABLE auth_rate_limits (
  key_digest TEXT PRIMARY KEY,
  window_started_at_utc TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  blocked_until_utc TEXT
);

CREATE TABLE attendance_events (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES children(id),
  child_name_snapshot TEXT NOT NULL,
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  guardian_name_snapshot TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_name_snapshot TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('sign_in', 'sign_out')),
  occurred_at_utc TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('guardian', 'provider')),
  request_id TEXT,
  created_at_utc TEXT NOT NULL,
  entry_reason TEXT,
  CHECK ((source = 'guardian' AND entry_reason IS NULL) OR
         (source = 'provider' AND length(trim(entry_reason)) > 0))
);
CREATE INDEX attendance_events_child_time_idx
  ON attendance_events(child_id, occurred_at_utc, id);
CREATE INDEX attendance_events_time_idx
  ON attendance_events(occurred_at_utc);
CREATE UNIQUE INDEX attendance_events_request_id_unique
  ON attendance_events(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE attendance_corrections (
  id TEXT PRIMARY KEY,
  attendance_event_id TEXT NOT NULL REFERENCES attendance_events(id),
  correction_kind TEXT NOT NULL CHECK (correction_kind IN ('void', 'replace')),
  replacement_child_id TEXT REFERENCES children(id),
  replacement_child_name_snapshot TEXT,
  replacement_guardian_id TEXT REFERENCES guardians(id),
  replacement_guardian_name_snapshot TEXT,
  replacement_action TEXT CHECK (replacement_action IN ('sign_in', 'sign_out')),
  replacement_occurred_at_utc TEXT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_name_snapshot TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  CHECK (
    (correction_kind = 'void' AND replacement_child_id IS NULL AND replacement_child_name_snapshot IS NULL AND
     replacement_guardian_id IS NULL AND replacement_guardian_name_snapshot IS NULL AND replacement_action IS NULL AND
     replacement_occurred_at_utc IS NULL)
    OR
    (correction_kind = 'replace' AND replacement_child_id IS NOT NULL AND replacement_child_name_snapshot IS NOT NULL AND
     replacement_guardian_id IS NOT NULL AND replacement_guardian_name_snapshot IS NOT NULL AND replacement_action IS NOT NULL AND
     replacement_occurred_at_utc IS NOT NULL)
  )
);
CREATE INDEX attendance_corrections_event_time_idx
  ON attendance_corrections(attendance_event_id, created_at_utc, id);

CREATE TRIGGER attendance_events_no_update
BEFORE UPDATE ON attendance_events
BEGIN
  SELECT RAISE(ABORT, 'attendance events are immutable');
END;

CREATE TRIGGER attendance_events_no_delete
BEFORE DELETE ON attendance_events
BEGIN
  SELECT RAISE(ABORT, 'attendance events are immutable');
END;

CREATE TRIGGER attendance_guardian_transition_check
BEFORE INSERT ON attendance_events
WHEN NEW.source IN ('guardian', 'provider')
BEGIN
  SELECT CASE WHEN
    (NEW.action = 'sign_in' AND COALESCE((
      SELECT COALESCE(lc.replacement_action, e.action)
      FROM attendance_events e
      LEFT JOIN attendance_corrections lc ON lc.id = (
        SELECT c.id FROM attendance_corrections c
        WHERE c.attendance_event_id = e.id
        ORDER BY c.created_at_utc DESC, c.id DESC LIMIT 1
      )
      WHERE (lc.correction_kind IS NULL OR lc.correction_kind != 'void')
        AND COALESCE(lc.replacement_child_id, e.child_id) = NEW.child_id
      ORDER BY COALESCE(lc.replacement_occurred_at_utc, e.occurred_at_utc) DESC,
        e.created_at_utc DESC, e.id DESC LIMIT 1
    ), '') = 'sign_in')
    OR
    (NEW.action = 'sign_out' AND COALESCE((
      SELECT COALESCE(lc.replacement_action, e.action)
      FROM attendance_events e
      LEFT JOIN attendance_corrections lc ON lc.id = (
        SELECT c.id FROM attendance_corrections c
        WHERE c.attendance_event_id = e.id
        ORDER BY c.created_at_utc DESC, c.id DESC LIMIT 1
      )
      WHERE (lc.correction_kind IS NULL OR lc.correction_kind != 'void')
        AND COALESCE(lc.replacement_child_id, e.child_id) = NEW.child_id
      ORDER BY COALESCE(lc.replacement_occurred_at_utc, e.occurred_at_utc) DESC,
        e.created_at_utc DESC, e.id DESC LIMIT 1
    ), '') != 'sign_in')
  THEN RAISE(ABORT, 'invalid attendance state transition') END;
END;

CREATE TRIGGER attendance_corrections_no_update
BEFORE UPDATE ON attendance_corrections
BEGIN
  SELECT RAISE(ABORT, 'attendance corrections are immutable');
END;

CREATE TRIGGER attendance_corrections_no_delete
BEFORE DELETE ON attendance_corrections
BEGIN
  SELECT RAISE(ABORT, 'attendance corrections are immutable');
END;
