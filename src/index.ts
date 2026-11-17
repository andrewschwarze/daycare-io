interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SETUP_SECRET?: string;
}

interface User {
  id: string;
  guardian_id: string | null;
  role: "provider" | "guardian";
  display_name: string;
  email_normalized: string;
  must_change_password: number;
}

interface SessionRow {
  token_digest: string;
  csrf_digest: string;
  expires_at_utc: string;
  revoked_at_utc: string | null;
  id: string;
  guardian_id: string | null;
  role: "provider" | "guardian";
  display_name: string;
  email_normalized: string;
  must_change_password: number;
}

interface CredentialRow {
  password_hash: string;
  salt: string;
  kdf_name: string;
  kdf_parameters_json: string;
}

const SESSION_SECONDS = 12 * 60 * 60;
const PBKDF2_ITERATIONS = 310_000;
const encoder = new TextEncoder();

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const out = new Headers(headers);
  out.set("Content-Type", "application/json; charset=utf-8");
  out.set("Cache-Control", "no-store");
  out.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers: out });
}

async function asset(request: Request, binding: Fetcher): Promise<Response> {
  const response = await binding.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function fail(status: number, message: string): never {
  throw new ApiError(status, message);
}

async function bodyJson<T>(request: Request): Promise<T> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid request.");
    return value as T;
  } catch {
    fail(400, "Invalid request.");
  }
}

function requiredText(value: unknown, label: string, max = 120): string {
  if (typeof value !== "string") fail(400, `Enter a valid ${label}.`);
  const text = value.trim();
  if (!text || text.length > max) fail(400, `Enter a valid ${label}.`);
  return text;
}

function normalizeEmail(value: unknown): string {
  const email = requiredText(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
  return email;
}

function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) {
    fail(400, "Use a password between 12 and 256 characters.");
  }
  return value;
}

function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function digest(value: string): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function passwordHash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function saveCredential(db: D1Database, userId: string, password: string, now: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = await passwordHash(password, salt);
  await db.prepare(`INSERT INTO credentials
    (user_id, password_hash, salt, kdf_name, kdf_parameters_json, updated_at_utc)
    VALUES (?, ?, ?, 'PBKDF2-SHA256', ?, ?)`)
    .bind(userId, toBase64(hash), toBase64(salt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now)
    .run();
}

async function verifyPassword(db: D1Database, userId: string, password: string): Promise<boolean> {
  const row = await db.prepare(`SELECT password_hash, salt, kdf_name, kdf_parameters_json
    FROM credentials WHERE user_id = ?`).bind(userId).first<CredentialRow>();
  if (!row || row.kdf_name !== "PBKDF2-SHA256") return false;
  let params: { iterations?: number };
  try { params = JSON.parse(row.kdf_parameters_json) as { iterations?: number }; } catch { return false; }
  if (!Number.isInteger(params.iterations) || params.iterations! < 100_000 || params.iterations! > 2_000_000) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(row.salt), iterations: params.iterations! }, key, 256,
  ));
  return constantTimeEqual(actual, fromBase64(row.password_hash));
}

function cookies(request: Request): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of (request.headers.get("Cookie") || "").split(";")) {
    const at = entry.indexOf("=");
    if (at < 0) continue;
    found.set(entry.slice(0, at).trim(), decodeURIComponent(entry.slice(at + 1).trim()));
  }
  return found;
}

function cookie(name: string, value: string, maxAge: number): string {
  const httpOnly = name === "daycare_session" ? "; HttpOnly" : "";
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; Secure${httpOnly}; SameSite=Strict`;
}

async function createSession(db: D1Database, userId: string, nowDate = new Date()): Promise<{ token: string; csrf: string }> {
  const token = base64Url(randomBytes(32));
  const csrf = base64Url(randomBytes(32));
  const now = nowDate.toISOString();
  const expires = new Date(nowDate.getTime() + SESSION_SECONDS * 1000).toISOString();
  await db.prepare(`INSERT INTO sessions (token_digest, csrf_digest, user_id, created_at_utc, expires_at_utc)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(await digest(token), await digest(csrf), userId, now, expires).run();
  return { token, csrf };
}

async function currentUser(request: Request, db: D1Database): Promise<{ row: SessionRow; user: User }> {
  const jar = cookies(request);
  const token = jar.get("daycare_session");
  if (!token) fail(401, "Sign in to continue.");
  const row = await db.prepare(`SELECT s.token_digest, s.csrf_digest, s.expires_at_utc, s.revoked_at_utc,
    u.id, u.guardian_id, u.role, u.display_name, u.email_normalized, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_digest = ? AND u.active = 1`)
    .bind(await digest(token)).first<SessionRow>();
  if (!row || row.revoked_at_utc || row.expires_at_utc <= new Date().toISOString()) fail(401, "Sign in to continue.");
  const csrf = jar.get("daycare_csrf");
  if (!csrf || !constantTimeEqual(fromBase64(await digest(csrf)), fromBase64(row.csrf_digest))) fail(403, "Refresh the page and try again.");
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) fail(403, "Request not allowed.");
    const header = request.headers.get("X-CSRF-Token");
    if (!header || !constantTimeEqual(encoder.encode(header), encoder.encode(csrf))) fail(403, "Refresh the page and try again.");
  }
  return { row, user: row };
}

async function requireProvider(user: User): Promise<void> {
  if (user.role !== "provider") fail(403, "Provider access required.");
}

async function rateLimit(db: D1Database, key: string, nowDate = new Date()): Promise<boolean> {
  const now = nowDate.toISOString();
  const windowStart = new Date(nowDate.getTime() - 15 * 60 * 1000).toISOString();
  const lockedUntil = new Date(nowDate.getTime() + 15 * 60 * 1000).toISOString();
  const keyDigest = await digest(key);
  const existing = await db.prepare("SELECT blocked_until_utc FROM auth_rate_limits WHERE key_digest = ?")
    .bind(keyDigest).first<{ blocked_until_utc: string | null }>();
  if (existing?.blocked_until_utc && existing.blocked_until_utc > now) return true;
  const result = await db.prepare(`INSERT INTO auth_rate_limits
    (key_digest, window_started_at_utc, attempt_count, blocked_until_utc)
    VALUES (?, ?, 1, NULL)
    ON CONFLICT(key_digest) DO UPDATE SET
      attempt_count = CASE WHEN auth_rate_limits.window_started_at_utc <= ? THEN 1 ELSE auth_rate_limits.attempt_count + 1 END,
      window_started_at_utc = CASE WHEN auth_rate_limits.window_started_at_utc <= ? THEN ? ELSE auth_rate_limits.window_started_at_utc END,
      blocked_until_utc = CASE
        WHEN auth_rate_limits.window_started_at_utc > ? AND auth_rate_limits.attempt_count >= 5 THEN ?
        WHEN auth_rate_limits.window_started_at_utc <= ? THEN NULL
        ELSE auth_rate_limits.blocked_until_utc END
    RETURNING attempt_count, blocked_until_utc`)
    .bind(keyDigest, now, windowStart, windowStart, now, windowStart, lockedUntil, windowStart)
    .first<{ attempt_count: number; blocked_until_utc: string | null }>();
  return Boolean(result?.blocked_until_utc && result.blocked_until_utc > now);
}

function assertId(value: unknown): string {
  const id = requiredText(value, "ID", 80);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(400, "Invalid ID.");
  return id;
}

interface ChildRow {
  id: string;
  first_name: string;
  last_name: string;
  active: number;
  present: number;
  last_event_at_utc: string | null;
}

async function childrenForUser(db: D1Database, user: User): Promise<ChildRow[]> {
  const accessClause = user.role === "provider"
    ? ""
    : `AND EXISTS (SELECT 1 FROM guardian_children gc WHERE gc.child_id = c.id AND gc.guardian_id = ? AND gc.active = 1)`;
  const activeClause = user.role === "provider" ? "" : "AND c.active = 1";
  const result = await db.prepare(`WITH latest_corrections AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY attendance_event_id ORDER BY created_at_utc DESC, id DESC) AS rn
      FROM attendance_corrections
    ), effective AS (
      SELECT COALESCE(lc.replacement_child_id, e.child_id) AS child_id,
        COALESCE(lc.replacement_action, e.action) AS action,
        COALESCE(lc.replacement_occurred_at_utc, e.occurred_at_utc) AS occurred_at_utc,
        e.created_at_utc, e.id,
        ROW_NUMBER() OVER (PARTITION BY COALESCE(lc.replacement_child_id, e.child_id)
          ORDER BY COALESCE(lc.replacement_occurred_at_utc, e.occurred_at_utc) DESC, e.created_at_utc DESC, e.id DESC) AS rn
      FROM attendance_events e
      LEFT JOIN latest_corrections lc ON lc.attendance_event_id = e.id AND lc.rn = 1
      WHERE lc.correction_kind IS NULL OR lc.correction_kind != 'void'
    ), current_state AS (
      SELECT child_id, action, occurred_at_utc FROM effective WHERE rn = 1
    )
    SELECT c.id, c.first_name, c.last_name, c.active,
      CASE WHEN cs.action = 'sign_in' THEN 1 ELSE 0 END AS present,
      CASE WHEN cs.action = 'sign_in' THEN cs.occurred_at_utc ELSE NULL END AS last_event_at_utc
    FROM children c LEFT JOIN current_state cs ON cs.child_id = c.id
    WHERE 1 = 1 ${activeClause} ${accessClause}
    ORDER BY c.first_name, c.last_name`)
    .bind(...(user.role === "provider" ? [] : [user.guardian_id])).all<ChildRow>();
  return result.results || [];
}

interface EventRow {
  id: string;
  child_id: string;
  child_name: string;
  guardian_id: string;
  guardian_name: string;
  actor_user_id: string;
  actor_name: string;
  action: string;
  occurred_at_utc: string;
  source: string;
  entry_reason: string | null;
  effective_child_id: string;
  effective_guardian_id: string;
  effective_action: string;
  effective_at_utc: string;
  correction_kind: string | null;
  replacement_child_name_snapshot: string | null;
  replacement_guardian_name_snapshot: string | null;
  correction_reason: string | null;
  correction_actor: string | null;
  created_at_utc: string;
  corrections_json: string;
  correction_history: Array<{ kind: string; reason: string; actor: string; createdAtUtc: string }>;
}

async function attendanceHistory(db: D1Database, user: User): Promise<EventRow[]> {
  const result = await db.prepare(`WITH latest_corrections AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY attendance_event_id ORDER BY created_at_utc DESC, id DESC) AS rn
      FROM attendance_corrections
    ), correction_history AS (
      SELECT attendance_event_id, json_group_array(json_object(
        'kind', correction_kind, 'reason', reason, 'actor', actor_name_snapshot,
        'createdAtUtc', created_at_utc
      )) AS corrections_json
      FROM attendance_corrections GROUP BY attendance_event_id
    )
    SELECT e.id, e.child_id, COALESCE(lc.replacement_child_name_snapshot, e.child_name_snapshot) AS child_name,
      e.guardian_id, COALESCE(lc.replacement_guardian_name_snapshot, e.guardian_name_snapshot) AS guardian_name,
      e.actor_user_id, e.actor_name_snapshot AS actor_name,
      e.action, e.occurred_at_utc, e.source, e.entry_reason,
      COALESCE(lc.replacement_child_id, e.child_id) AS effective_child_id,
      COALESCE(lc.replacement_guardian_id, e.guardian_id) AS effective_guardian_id,
      COALESCE(lc.replacement_action, e.action) AS effective_action,
      COALESCE(lc.replacement_occurred_at_utc, e.occurred_at_utc) AS effective_at_utc,
      lc.correction_kind, lc.replacement_child_name_snapshot, lc.replacement_guardian_name_snapshot,
      lc.reason AS correction_reason, lc.actor_name_snapshot AS correction_actor,
      e.created_at_utc, COALESCE(ch.corrections_json, '[]') AS corrections_json
    FROM attendance_events e
    LEFT JOIN latest_corrections lc ON lc.attendance_event_id = e.id AND lc.rn = 1
    LEFT JOIN correction_history ch ON ch.attendance_event_id = e.id
    WHERE (? = 'provider' OR COALESCE(lc.replacement_guardian_id, e.guardian_id) = ?)
    ORDER BY e.occurred_at_utc DESC, e.created_at_utc DESC LIMIT 500`)
    .bind(user.role, user.guardian_id).all<EventRow>();
  return (result.results || []).map((row) => ({ ...row, correction_history: JSON.parse(row.corrections_json) }));
}

async function requireGuardianChild(db: D1Database, guardianId: string, childId: string): Promise<void> {
  const row = await db.prepare(`SELECT 1 AS ok FROM guardian_children gc
    JOIN guardians g ON g.id = gc.guardian_id JOIN children c ON c.id = gc.child_id
    WHERE gc.guardian_id = ? AND gc.child_id = ? AND gc.active = 1 AND g.active = 1 AND c.active = 1`)
    .bind(guardianId, childId).first<{ ok: number }>();
  if (!row) fail(403, "You are not authorized to manage this child.");
}

async function setup(request: Request, env: Env): Promise<Response> {
  if (!env.SETUP_SECRET) fail(503, "Local setup is not configured. See the setup instructions.");
  const body = await bodyJson<{ setupSecret: string; email: string; name: string; password: string }>(request);
  const given = encoder.encode(String(body.setupSecret || ""));
  const expected = encoder.encode(env.SETUP_SECRET);
  if (!constantTimeEqual(await crypto.subtle.digest("SHA-256", given).then((x) => new Uint8Array(x)), await crypto.subtle.digest("SHA-256", expected).then((x) => new Uint8Array(x)))) {
    fail(401, "Setup code is incorrect.");
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'provider'")
    .first<{ count: number }>();
  if ((count?.count || 0) > 0) fail(409, "The provider account is already set up.");
  const email = normalizeEmail(body.email);
  const name = requiredText(body.name, "name");
  const password = validatePassword(body.password);
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO users (id, role, display_name, email_normalized, created_at_utc)
    VALUES (?, 'provider', ?, ?, ?)`)
    .bind(userId, name, email, now).run();
  await saveCredential(env.DB, userId, password, now);
  const pair = await createSession(env.DB, userId);
  const headers = new Headers();
  headers.append("Set-Cookie", cookie("daycare_session", pair.token, SESSION_SECONDS));
  headers.append("Set-Cookie", cookie("daycare_csrf", pair.csrf, SESSION_SECONDS));
  return json({ ok: true }, 201, headers);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ email: string; password: string }>(request);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const locked = await rateLimit(env.DB, `${email}:${ip}`);
  if (locked) fail(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
  const user = await env.DB.prepare(`SELECT id, guardian_id, role, display_name, email_normalized, must_change_password
    FROM users WHERE email_normalized = ? AND active = 1`).bind(email).first<User>();
  const valid = user && password.length <= 256
    ? await verifyPassword(env.DB, user.id, password)
    : (await passwordHash(password.slice(0, 256), new Uint8Array(16)), false);
  if (!user || !valid) {
    fail(401, "Email or password is incorrect.");
  }
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE key_digest = ?").bind(await digest(`${email}:${ip}`)).run();
  const pair = await createSession(env.DB, user.id);
  const headers = new Headers();
  headers.append("Set-Cookie", cookie("daycare_session", pair.token, SESSION_SECONDS));
  headers.append("Set-Cookie", cookie("daycare_csrf", pair.csrf, SESSION_SECONDS));
  return json({ user: { id: user.id, name: user.display_name, role: user.role, mustChangePassword: Boolean(user.must_change_password) } }, 200, headers);
}

async function clearSession(request: Request, db: D1Database): Promise<void> {
  const token = cookies(request).get("daycare_session");
  if (token) await db.prepare("UPDATE sessions SET revoked_at_utc = ? WHERE token_digest = ?")
    .bind(new Date().toISOString(), await digest(token)).run();
}

function clearedCookies(): Headers {
  const headers = new Headers();
  headers.append("Set-Cookie", cookie("daycare_session", "", 0));
  headers.append("Set-Cookie", cookie("daycare_csrf", "", 0).replace("; HttpOnly", ""));
  return headers;
}

async function createChild(request: Request, db: D1Database): Promise<Response> {
  const body = await bodyJson<{ firstName: string; lastName: string }>(request);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO children (id, first_name, last_name, created_at_utc) VALUES (?, ?, ?, ?)")
    .bind(id, requiredText(body.firstName, "first name", 80), requiredText(body.lastName, "last name", 80), now).run();
  return json({ id }, 201);
}

async function updateChild(request: Request, db: D1Database, id: string): Promise<Response> {
  const body = await bodyJson<{ firstName?: string; lastName?: string; active?: boolean }>(request);
  const existing = await db.prepare("SELECT first_name, last_name, active FROM children WHERE id = ?").bind(id)
    .first<{ first_name: string; last_name: string; active: number }>();
  if (!existing) fail(404, "Child not found.");
  const first = body.firstName === undefined ? existing.first_name : requiredText(body.firstName, "first name", 80);
  const last = body.lastName === undefined ? existing.last_name : requiredText(body.lastName, "last name", 80);
  if (body.active !== undefined && typeof body.active !== "boolean") fail(400, "Choose an active state.");
  const active = body.active === undefined ? existing.active : body.active ? 1 : 0;
  const now = new Date().toISOString();
  await db.prepare(`UPDATE children SET first_name = ?, last_name = ?, active = ?,
    deactivated_at_utc = CASE WHEN ? = 0 THEN COALESCE(deactivated_at_utc, ?) ELSE NULL END WHERE id = ?`)
    .bind(first, last, active, active, now, id).run();
  return json({ ok: true });
}

async function createGuardian(request: Request, db: D1Database): Promise<Response> {
  const body = await bodyJson<{ name: string; email: string; childIds: string[] }>(request);
  const name = requiredText(body.name, "guardian name");
  const email = normalizeEmail(body.email);
  const childIds = [...new Set((Array.isArray(body.childIds) ? body.childIds : []).map(assertId))];
  if (!childIds.length) fail(400, "Choose at least one child for this guardian.");
  for (const childId of childIds) {
    const child = await db.prepare("SELECT 1 FROM children WHERE id = ? AND active = 1").bind(childId).first();
    if (!child) fail(400, "Choose an active child.");
  }
  const guardianId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const temporaryPassword = base64Url(randomBytes(18));
  const salt = randomBytes(16);
  const hash = await passwordHash(temporaryPassword, salt);
  const statements = [
    db.prepare("INSERT INTO guardians (id, display_name, created_at_utc) VALUES (?, ?, ?)").bind(guardianId, name, now),
    db.prepare(`INSERT INTO users (id, guardian_id, role, display_name, email_normalized, must_change_password, created_at_utc)
      VALUES (?, ?, 'guardian', ?, ?, 1, ?)`)
      .bind(userId, guardianId, name, email, now),
    db.prepare(`INSERT INTO credentials (user_id, password_hash, salt, kdf_name, kdf_parameters_json, updated_at_utc)
      VALUES (?, ?, ?, 'PBKDF2-SHA256', ?, ?)`)
      .bind(userId, toBase64(hash), toBase64(salt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now),
    ...childIds.map((childId) => db.prepare(`INSERT INTO guardian_children (guardian_id, child_id, created_at_utc)
      VALUES (?, ?, ?)`).bind(guardianId, childId, now)),
  ];
  await db.batch(statements);
  return json({ id: guardianId, temporaryPassword }, 201);
}

async function updateGuardian(request: Request, db: D1Database, id: string): Promise<Response> {
  const body = await bodyJson<{ name?: string; email?: string; active?: boolean }>(request);
  const current = await db.prepare(`SELECT g.display_name, g.active, u.id AS user_id, u.email_normalized
    FROM guardians g JOIN users u ON u.guardian_id = g.id WHERE g.id = ?`).bind(id)
    .first<{ display_name: string; active: number; user_id: string; email_normalized: string }>();
  if (!current) fail(404, "Guardian not found.");
  const name = body.name === undefined ? current.display_name : requiredText(body.name, "guardian name");
  const email = body.email === undefined ? current.email_normalized : normalizeEmail(body.email);
  if (body.active !== undefined && typeof body.active !== "boolean") fail(400, "Choose an active state.");
  const active = body.active === undefined ? current.active : body.active ? 1 : 0;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE guardians SET display_name = ?, active = ?,
      deactivated_at_utc = CASE WHEN ? = 0 THEN COALESCE(deactivated_at_utc, ?) ELSE NULL END WHERE id = ?`)
      .bind(name, active, active, now, id),
    db.prepare(`UPDATE users SET display_name = ?, email_normalized = ?, active = ?,
      deactivated_at_utc = CASE WHEN ? = 0 THEN COALESCE(deactivated_at_utc, ?) ELSE NULL END WHERE id = ?`)
      .bind(name, email, active, active, now, current.user_id),
    ...(active ? [] : [db.prepare("UPDATE sessions SET revoked_at_utc = ? WHERE user_id = ? AND revoked_at_utc IS NULL")
      .bind(now, current.user_id)]),
  ]);
  return json({ ok: true });
}

async function updateGuardianChildren(request: Request, db: D1Database, guardianId: string): Promise<Response> {
  const body = await bodyJson<{ childIds: string[] }>(request);
  const guardian = await db.prepare("SELECT 1 FROM guardians WHERE id = ? AND active = 1").bind(guardianId).first();
  if (!guardian) fail(404, "Guardian not found.");
  if (!Array.isArray(body.childIds)) fail(400, "Choose the children this guardian may manage.");
  const childIds = [...new Set(body.childIds.map(assertId))];
  for (const childId of childIds) {
    const child = await db.prepare("SELECT 1 FROM children WHERE id = ? AND active = 1").bind(childId).first();
    if (!child) fail(400, "Choose an active child.");
  }
  const now = new Date().toISOString();
  const statements = [db.prepare(`UPDATE guardian_children SET active = 0, deactivated_at_utc = ?
    WHERE guardian_id = ? AND active = 1`).bind(now, guardianId)];
  for (const childId of childIds) {
    statements.push(db.prepare(`INSERT INTO guardian_children (guardian_id, child_id, active, created_at_utc)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(guardian_id, child_id) DO UPDATE SET active = 1, deactivated_at_utc = NULL`)
      .bind(guardianId, childId, now));
  }
  await db.batch(statements);
  return json({ ok: true });
}

async function recordAttendance(request: Request, db: D1Database, user: User): Promise<Response> {
  if (user.role !== "guardian" || !user.guardian_id) fail(403, "Guardian access required.");
  const body = await bodyJson<{ childId: string; action: "sign_in" | "sign_out"; requestId: string }>(request);
  const childId = assertId(body.childId);
  if (body.action !== "sign_in" && body.action !== "sign_out") fail(400, "Choose sign in or sign out.");
  const requestId = assertId(body.requestId);
  await requireGuardianChild(db, user.guardian_id, childId);
  const state = await childrenForUser(db, user);
  const child = state.find((item) => item.id === childId);
  if (!child) fail(404, "Child not found.");
  if ((body.action === "sign_in" && child.present) || (body.action === "sign_out" && !child.present)) {
    fail(409, "Attendance has changed. Refresh and try again.");
  }
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO attendance_events
      (id, child_id, child_name_snapshot, guardian_id, guardian_name_snapshot, actor_user_id, actor_name_snapshot,
       action, occurred_at_utc, source, request_id, created_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'guardian', ?, ?)`)
      .bind(crypto.randomUUID(), childId, `${child.first_name} ${child.last_name}`, user.guardian_id,
        user.display_name, user.id, user.display_name, body.action, now, requestId, now).run();
  } catch {
    fail(409, "This attendance action was already recorded. Refresh the page.");
  }
  return json({ ok: true, occurredAtUtc: now }, 201);
}

async function recordAttendanceBatch(request: Request, db: D1Database, user: User): Promise<Response> {
  if (user.role !== "guardian" || !user.guardian_id) fail(403, "Guardian access required.");
  const body = await bodyJson<{ childIds: string[]; action: "sign_in" | "sign_out"; requestId: string }>(request);
  if (!Array.isArray(body.childIds) || body.childIds.length < 1 || body.childIds.length > 20) fail(400, "Choose between one and 20 children.");
  if (body.action !== "sign_in" && body.action !== "sign_out") fail(400, "Choose sign in or sign out.");
  const childIds = [...new Set(body.childIds.map(assertId))];
  if (childIds.length !== body.childIds.length) fail(400, "A child was selected more than once.");
  const requestId = assertId(body.requestId);
  const children = await childrenForUser(db, user);
  for (const childId of childIds) {
    await requireGuardianChild(db, user.guardian_id, childId);
    const child = children.find((item) => item.id === childId);
    if (!child || (body.action === "sign_in" && child.present) || (body.action === "sign_out" && !child.present)) {
      fail(409, "Attendance has changed. Refresh and try again.");
    }
  }
  const now = new Date().toISOString();
  const statements = childIds.map((childId, index) => {
    const child = children.find((item) => item.id === childId)!;
    return db.prepare(`INSERT INTO attendance_events
      (id, child_id, child_name_snapshot, guardian_id, guardian_name_snapshot, actor_user_id, actor_name_snapshot,
       action, occurred_at_utc, source, request_id, created_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'guardian', ?, ?)`)
      .bind(crypto.randomUUID(), childId, `${child.first_name} ${child.last_name}`, user.guardian_id,
        user.display_name, user.id, user.display_name, body.action, now, `${requestId}-${index}`, now);
  });
  try { await db.batch(statements); }
  catch { fail(409, "Attendance changed while you submitted. Refresh and try again."); }
  return json({ ok: true, occurredAtUtc: now }, 201);
}

async function providerAttendance(request: Request, db: D1Database, user: User): Promise<Response> {
  await requireProvider(user);
  const body = await bodyJson<{ childId: string; guardianId: string; action: "sign_in" | "sign_out"; reason: string; requestId: string }>(request);
  const childId = assertId(body.childId);
  const guardianId = assertId(body.guardianId);
  if (body.action !== "sign_in" && body.action !== "sign_out") fail(400, "Choose sign in or sign out.");
  const reason = requiredText(body.reason, "reason for provider entry", 1000);
  if (body.action === "sign_in") {
    await requireGuardianChild(db, guardianId, childId);
  } else {
    const linked = await db.prepare(`SELECT 1 FROM guardian_children WHERE guardian_id = ? AND child_id = ? AND active = 1`)
      .bind(guardianId, childId).first();
    if (!linked) fail(400, "Choose a guardian linked to this child.");
  }
  const children = await childrenForUser(db, user);
  const child = children.find((entry) => entry.id === childId);
  if (!child || (body.action === "sign_in" && child.present) || (body.action === "sign_out" && !child.present)) {
    fail(409, "Attendance has changed. Refresh and try again.");
  }
  const guardian = await db.prepare("SELECT display_name, active FROM guardians WHERE id = ?")
    .bind(guardianId).first<{ display_name: string }>();
  if (!guardian || (body.action === "sign_in" && !guardian.active)) fail(400, "Choose an active guardian.");
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO attendance_events
      (id, child_id, child_name_snapshot, guardian_id, guardian_name_snapshot, actor_user_id, actor_name_snapshot,
       action, occurred_at_utc, source, request_id, created_at_utc, entry_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider', ?, ?, ?)`)
      .bind(crypto.randomUUID(), childId, `${child.first_name} ${child.last_name}`, guardianId, guardian.display_name,
        user.id, user.display_name, body.action, now, assertId(body.requestId), now, reason).run();
  } catch {
    fail(409, "Attendance has changed or this action was already recorded. Refresh and try again.");
  }
  return json({ ok: true, occurredAtUtc: now }, 201);
}

async function addCorrection(request: Request, db: D1Database, user: User, eventId: string): Promise<Response> {
  await requireProvider(user);
  const body = await bodyJson<{
    kind: "void" | "replace";
    reason: string;
    childId?: string;
    guardianId?: string;
    action?: "sign_in" | "sign_out";
    occurredAtUtc?: string;
  }>(request);
  const original = await db.prepare(`SELECT child_id, child_name_snapshot, guardian_id, guardian_name_snapshot, action, occurred_at_utc
    FROM attendance_events WHERE id = ?`).bind(eventId)
    .first<{ child_id: string; child_name_snapshot: string; guardian_id: string; guardian_name_snapshot: string; action: "sign_in" | "sign_out"; occurred_at_utc: string }>();
  if (!original) fail(404, "Attendance event not found.");
  if (body.kind !== "void" && body.kind !== "replace") fail(400, "Choose a correction type.");
  const reason = requiredText(body.reason, "correction reason", 1000);
  const now = new Date().toISOString();
  if (body.kind === "void") {
    await db.prepare(`INSERT INTO attendance_corrections
      (id, attendance_event_id, correction_kind, reason, actor_user_id, actor_name_snapshot, created_at_utc)
      VALUES (?, ?, 'void', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), eventId, reason, user.id, user.display_name, now).run();
  } else {
    const childId = assertId(body.childId || original.child_id);
    const guardianId = assertId(body.guardianId || original.guardian_id);
    const action = body.action || original.action;
    const occurredAt = body.occurredAtUtc || original.occurred_at_utc;
    if (action !== "sign_in" && action !== "sign_out") fail(400, "Choose sign in or sign out.");
    if (!Number.isFinite(Date.parse(occurredAt))) fail(400, "Enter a valid event time.");
    const related = await db.prepare(`SELECT 1 FROM guardian_children WHERE guardian_id = ? AND child_id = ?`)
      .bind(guardianId, childId).first();
    if (!related) fail(400, "That guardian is not linked to the selected child.");
    const childName = childId === original.child_id
      ? original.child_name_snapshot
      : await db.prepare("SELECT first_name || ' ' || last_name AS name FROM children WHERE id = ?").bind(childId).first<{ name: string }>().then((row) => row?.name);
    const guardianName = guardianId === original.guardian_id
      ? original.guardian_name_snapshot
      : await db.prepare("SELECT display_name AS name FROM guardians WHERE id = ?").bind(guardianId).first<{ name: string }>().then((row) => row?.name);
    if (!childName || !guardianName) fail(400, "Choose a valid child and guardian.");
    await db.prepare(`INSERT INTO attendance_corrections
      (id, attendance_event_id, correction_kind, replacement_child_id, replacement_child_name_snapshot,
       replacement_guardian_id, replacement_guardian_name_snapshot, replacement_action,
       replacement_occurred_at_utc, reason, actor_user_id, actor_name_snapshot, created_at_utc)
      VALUES (?, ?, 'replace', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), eventId, childId, childName, guardianId, guardianName, action,
        new Date(occurredAt).toISOString(), reason, user.id, user.display_name, now).run();
  }
  return json({ ok: true }, 201);
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(rows: EventRow[]): Response {
  const columns = ["event_id", "child", "guardian", "action", "timestamp_utc", "original_action", "original_timestamp_utc", "source", "entry_reason", "actor", "correction", "correction_reason", "corrected_by", "correction_history_json"];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.id,
      row.child_name,
      row.guardian_name,
      row.correction_kind === "void" ? "voided" : row.effective_action,
      row.effective_at_utc,
      row.action,
      row.occurred_at_utc,
      row.source,
      row.entry_reason || "",
      row.actor_name,
      row.correction_kind || "",
      row.correction_reason || "",
      row.correction_actor || "",
      JSON.stringify(row.correction_history),
    ].map(csvCell).join(","));
  }
  return new Response(lines.join("\r\n"), { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": "attachment; filename=attendance.csv",
    "Cache-Control": "no-store",
  } });
}

async function changePassword(request: Request, db: D1Database, user: User): Promise<Response> {
  const body = await bodyJson<{ currentPassword: string; newPassword: string }>(request);
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = validatePassword(body.newPassword);
  if (!await verifyPassword(db, user.id, current)) fail(401, "Current password is incorrect.");
  const now = new Date().toISOString();
  const salt = randomBytes(16);
  const hash = await passwordHash(next, salt);
  await db.batch([
    db.prepare(`UPDATE credentials SET password_hash = ?, salt = ?, kdf_name = 'PBKDF2-SHA256',
      kdf_parameters_json = ?, updated_at_utc = ? WHERE user_id = ?`)
      .bind(toBase64(hash), toBase64(salt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now, user.id),
    db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").bind(user.id),
    db.prepare("UPDATE sessions SET revoked_at_utc = ? WHERE user_id = ? AND revoked_at_utc IS NULL").bind(now, user.id),
  ]);
  const pair = await createSession(db, user.id);
  const headers = new Headers();
  headers.append("Set-Cookie", cookie("daycare_session", pair.token, SESSION_SECONDS));
  headers.append("Set-Cookie", cookie("daycare_csrf", pair.csrf, SESSION_SECONDS));
  return json({ ok: true }, 200, headers);
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return asset(request, env.ASSETS);
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "Request not allowed." }, 403);
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/setup-status") {
        const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'provider'").first<{ count: number }>();
        return json({ setupRequired: (result?.count || 0) === 0 });
      }
      if (request.method === "POST" && url.pathname === "/api/setup") return await setup(request, env);
      if (request.method === "POST" && url.pathname === "/api/login") return await login(request, env);

      const { row, user } = await currentUser(request, env.DB);
      if (request.method === "POST" && url.pathname === "/api/logout") {
        await clearSession(request, env.DB);
        return json({ ok: true }, 200, clearedCookies());
      }
      if (request.method === "GET" && url.pathname === "/api/me") {
        return json({ user: { id: user.id, name: user.display_name, email: user.email_normalized, role: user.role, mustChangePassword: Boolean(user.must_change_password) } });
      }
      if (request.method === "POST" && url.pathname === "/api/password") return await changePassword(request, env.DB, user);
      if (user.must_change_password && url.pathname !== "/api/logout" && url.pathname !== "/api/me" && url.pathname !== "/api/password") {
        fail(403, "Change your temporary password before continuing.");
      }
      if (request.method === "GET" && url.pathname === "/api/children") return json({ children: await childrenForUser(env.DB, user) });
      if (request.method === "POST" && url.pathname === "/api/children") {
        await requireProvider(user);
        return await createChild(request, env.DB);
      }
      const childMatch = url.pathname.match(/^\/api\/children\/([A-Za-z0-9_-]+)$/);
      if (request.method === "PATCH" && childMatch) {
        await requireProvider(user);
        return await updateChild(request, env.DB, childMatch[1]);
      }
      if (request.method === "GET" && url.pathname === "/api/guardians") {
        await requireProvider(user);
        const guardians = await env.DB.prepare(`SELECT g.id, g.display_name AS name, g.active, u.email_normalized AS email,
          GROUP_CONCAT(CASE WHEN gc.active = 1 THEN gc.child_id END) AS child_ids
          FROM guardians g JOIN users u ON u.guardian_id = g.id
          LEFT JOIN guardian_children gc ON gc.guardian_id = g.id
          GROUP BY g.id ORDER BY g.display_name`).all();
        return json({ guardians: guardians.results || [] });
      }
      if (request.method === "POST" && url.pathname === "/api/guardians") {
        await requireProvider(user);
        return await createGuardian(request, env.DB);
      }
      const guardianChildrenMatch = url.pathname.match(/^\/api\/guardians\/([A-Za-z0-9_-]+)\/children$/);
      if (request.method === "PUT" && guardianChildrenMatch) {
        await requireProvider(user);
        return await updateGuardianChildren(request, env.DB, guardianChildrenMatch[1]);
      }
      const guardianMatch = url.pathname.match(/^\/api\/guardians\/([A-Za-z0-9_-]+)$/);
      if (request.method === "PATCH" && guardianMatch) {
        await requireProvider(user);
        return await updateGuardian(request, env.DB, guardianMatch[1]);
      }
      if (request.method === "GET" && url.pathname === "/api/attendance") return json({ events: await attendanceHistory(env.DB, user) });
      if (request.method === "POST" && url.pathname === "/api/attendance/provider") return await providerAttendance(request, env.DB, user);
      if (request.method === "POST" && url.pathname === "/api/attendance/batch") return await recordAttendanceBatch(request, env.DB, user);
      if (request.method === "POST" && url.pathname === "/api/attendance") return await recordAttendance(request, env.DB, user);
      const correctionMatch = url.pathname.match(/^\/api\/attendance\/([A-Za-z0-9_-]+)\/corrections$/);
      if (request.method === "POST" && correctionMatch) return await addCorrection(request, env.DB, user, correctionMatch[1]);
      if (request.method === "GET" && url.pathname === "/api/export.csv") {
        await requireProvider(user);
        return csv(await attendanceHistory(env.DB, user));
      }
      fail(404, "Not found.");
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      return json({ error: "The request could not be completed." }, 500);
    }
  },
};

export default worker;
