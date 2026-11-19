interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SETUP_SECRET?: string;
}

interface User {
  id: string;
  family_id: string | null;
  role: "provider" | "family";
  display_name: string;
  email_normalized: string;
  must_change_password: number;
}

interface SessionRow {
  token_digest: string;
  csrf_digest: string;
  expires_at_utc: string;
  absolute_expires_at_utc: string;
  revoked_at_utc: string | null;
  id: string;
  family_id: string | null;
  role: "provider" | "family";
  display_name: string;
  email_normalized: string;
  must_change_password: number;
  active: number;
  provider_recovery_acknowledged_at_utc: string | null;
}

interface CredentialRow {
  password_hash: string;
  salt: string;
  kdf_name: string;
  kdf_parameters_json: string;
}

const PROVIDER_IDLE_SECONDS = 12 * 60 * 60;
const PROVIDER_MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
const FAMILY_SESSION_SECONDS = 30 * 24 * 60 * 60;
// Cloudflare Workers WebCrypto rejects PBKDF2 iteration counts above 100,000.
const PBKDF2_ITERATIONS = 100_000;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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

const providerDownloads: Record<string, string> = {
  "/downloads/provider-guide.docx": "provider-guide.docx",
  "/downloads/technical-provider-guide.docx": "technical-provider-guide.docx",
};

async function downloadProviderGuide(request: Request, env: Env, fileName: string): Promise<Response> {
  try {
    if (request.method !== "GET") fail(405, "Method not allowed.");
    const { user } = await currentUser(request, env.DB);
    await requireProvider(user);
    if (user.must_change_password) fail(403, "Change your temporary password before continuing.");
    const response = await asset(request, env.ASSETS);
    if (!response.ok) return json({ error: "Guide not found." }, 404);
    const headers = new Headers(response.headers);
    headers.set("Content-Disposition", `attachment; filename="${fileName}"`);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    return json({ error: "The request could not be completed." }, 500);
  }
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

function recoveryPhrase(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return encoded.match(/.{1,4}/g)!.join("-");
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
  return row ? verifyStoredSecret(row, password) : false;
}

async function matchingFamilyIds(db: D1Database, pin: string, excludedFamilyId?: string, includeInactive = false): Promise<string[]> {
  const result = await db.prepare(`SELECT f.id, pc.pin_hash AS password_hash, pc.salt,
      pc.kdf_name, pc.kdf_parameters_json
    FROM families f JOIN family_pin_credentials pc ON pc.family_id = f.id
    WHERE (? = 1 OR f.active = 1) AND (? IS NULL OR f.id <> ?)`)
    .bind(includeInactive ? 1 : 0, excludedFamilyId || null, excludedFamilyId || null).all<CredentialRow & { id: string }>();
  const matches: string[] = [];
  for (const row of result.results || []) if (await verifyStoredSecret(row, pin)) matches.push(row.id);
  return matches;
}

async function generateUniqueFamilyPin(db: D1Database, excludedFamilyId?: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    if ((await matchingFamilyIds(db, pin, excludedFamilyId, true)).length === 0) return pin;
  }
  fail(503, "A new family PIN could not be generated. Try again.");
}

async function verifyFamilyPin(db: D1Database, pin: string): Promise<string | null> {
  const matches = await matchingFamilyIds(db, pin);
  if (matches.length === 0) await passwordHash(pin, new Uint8Array(16));
  return matches.length === 1 ? matches[0] : null;
}

async function verifyStoredSecret(row: CredentialRow, secret: string): Promise<boolean> {
  if (!row || row.kdf_name !== "PBKDF2-SHA256") return false;
  let params: { iterations?: number };
  try { params = JSON.parse(row.kdf_parameters_json) as { iterations?: number }; } catch { return false; }
  if (!Number.isInteger(params.iterations) || params.iterations! < 100_000 || params.iterations! > 2_000_000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveBits"]);
    const actual = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(row.salt), iterations: params.iterations! }, key, 256,
    ));
    return constantTimeEqual(actual, fromBase64(row.password_hash));
  } catch {
    return false;
  }
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

function sessionDurations(role: User["role"]): { idleSeconds: number; absoluteSeconds: number } {
  return role === "family"
    ? { idleSeconds: FAMILY_SESSION_SECONDS, absoluteSeconds: FAMILY_SESSION_SECONDS }
    : { idleSeconds: PROVIDER_IDLE_SECONDS, absoluteSeconds: PROVIDER_MAX_SESSION_SECONDS };
}

async function createSession(db: D1Database, userId: string, role: User["role"], nowDate = new Date()): Promise<{ token: string; csrf: string }> {
  const token = base64Url(randomBytes(32));
  const csrf = base64Url(randomBytes(32));
  const now = nowDate.toISOString();
  const duration = sessionDurations(role);
  const expires = new Date(nowDate.getTime() + duration.idleSeconds * 1000).toISOString();
  const absoluteExpires = new Date(nowDate.getTime() + duration.absoluteSeconds * 1000).toISOString();
  await db.prepare(`INSERT INTO sessions
    (token_digest, csrf_digest, user_id, family_id, created_at_utc, expires_at_utc, absolute_expires_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(await digest(token), await digest(csrf), role === "provider" ? userId : null,
      role === "family" ? userId : null, now, expires, absoluteExpires).run();
  return { token, csrf };
}

async function currentUser(request: Request, db: D1Database): Promise<{ row: SessionRow; user: User; recoveryAcknowledged: boolean }> {
  const jar = cookies(request);
  const token = jar.get("daycare_session");
  if (!token) fail(401, "Sign in to continue.");
  const row = await db.prepare(`SELECT s.token_digest, s.csrf_digest, s.expires_at_utc, s.absolute_expires_at_utc, s.revoked_at_utc,
    COALESCE(u.id, f.id) AS id, f.id AS family_id,
    CASE WHEN u.id IS NULL THEN 'family' ELSE 'provider' END AS role,
    COALESCE(u.display_name, f.display_name) AS display_name,
    COALESCE(u.email_normalized, '') AS email_normalized, COALESCE(u.must_change_password, 0) AS must_change_password,
    COALESCE(u.active, f.active) AS active,
    pr.acknowledged_at_utc AS provider_recovery_acknowledged_at_utc
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN families f ON f.id = s.family_id
    LEFT JOIN provider_recovery pr ON pr.user_id = u.id AND u.role = 'provider'
    WHERE s.token_digest = ? AND (u.active = 1 OR f.active = 1)`)
    .bind(await digest(token)).first<SessionRow>();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  if (!row || row.revoked_at_utc || row.expires_at_utc <= now || row.absolute_expires_at_utc <= now) fail(401, "Sign in to continue.");
  const csrf = jar.get("daycare_csrf");
  if (!csrf || !constantTimeEqual(fromBase64(await digest(csrf)), fromBase64(row.csrf_digest))) fail(403, "Refresh the page and try again.");
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) fail(403, "Request not allowed.");
    const header = request.headers.get("X-CSRF-Token");
    if (!header || !constantTimeEqual(encoder.encode(header), encoder.encode(csrf))) fail(403, "Refresh the page and try again.");
  }
  const duration = sessionDurations(row.role);
  const slidingExpiry = new Date(Math.min(nowDate.getTime() + duration.idleSeconds * 1000, Date.parse(row.absolute_expires_at_utc))).toISOString();
  if (slidingExpiry > row.expires_at_utc) {
    await db.prepare("UPDATE sessions SET expires_at_utc = ? WHERE token_digest = ? AND revoked_at_utc IS NULL")
      .bind(slidingExpiry, row.token_digest).run();
  }
  return { row, user: row, recoveryAcknowledged: row.role !== "provider" || Boolean(row.provider_recovery_acknowledged_at_utc) };
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

function sessionHeaders(pair: { token: string; csrf: string }, role: User["role"]): Headers {
  const maxAge = sessionDurations(role).absoluteSeconds;
  const headers = new Headers();
  headers.append("Set-Cookie", cookie("daycare_session", pair.token, maxAge));
  headers.append("Set-Cookie", cookie("daycare_csrf", pair.csrf, maxAge));
  return headers;
}

async function storeProviderRecoveryPhrase(db: D1Database, userId: string, phrase = recoveryPhrase()): Promise<string> {
  const salt = randomBytes(16);
  const hash = await passwordHash(phrase, salt);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO provider_recovery
    (user_id, phrase_hash, salt, kdf_name, kdf_parameters_json, updated_at_utc, acknowledged_at_utc)
    VALUES (?, ?, ?, 'PBKDF2-SHA256', ?, ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET phrase_hash = excluded.phrase_hash, salt = excluded.salt,
      kdf_name = excluded.kdf_name, kdf_parameters_json = excluded.kdf_parameters_json,
      updated_at_utc = excluded.updated_at_utc, acknowledged_at_utc = NULL`)
    .bind(userId, toBase64(hash), toBase64(salt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now).run();
  return phrase;
}

async function acknowledgeProviderRecovery(db: D1Database, user: User): Promise<Response> {
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE provider_recovery SET acknowledged_at_utc = ? WHERE user_id = ?")
    .bind(now, user.id).run();
  if (!result.meta.changes) fail(409, "Generate a recovery phrase before acknowledging it.");
  await db.batch([
    db.prepare(`UPDATE account_recovery_codes SET revoked_at_utc = ? WHERE user_id = ?
      AND used_at_utc IS NULL AND revoked_at_utc IS NULL`).bind(now, user.id),
    db.prepare(`INSERT INTO security_audit_events (id, actor_user_id, subject_user_id, event_type, created_at_utc)
      VALUES (?, ?, ?, 'provider_recovery_acknowledged', ?)`).bind(crypto.randomUUID(), user.id, user.id, now),
  ]);
  return json({ ok: true });
}

async function rotateProviderRecovery(db: D1Database, user: User, request: Request): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await rateLimit(db, `provider-recovery-issue:${user.id}:${ip}`)) {
    fail(429, "Too many recovery phrase requests. Wait 15 minutes and try again.");
  }
  const phrase = await storeProviderRecoveryPhrase(db, user.id);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO security_audit_events (id, actor_user_id, subject_user_id, event_type, created_at_utc)
    VALUES (?, ?, ?, 'provider_recovery_phrase_rotated', ?)`).bind(crypto.randomUUID(), user.id, user.id, now).run();
  return json({ recoveryPhrase: phrase });
}

async function revokeFamilySessions(db: D1Database, familyId: string): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE sessions SET revoked_at_utc = ? WHERE family_id = ? AND revoked_at_utc IS NULL")
    .bind(now, familyId).run();
  return result.meta.changes;
}

async function revokeOtherProviderSessions(db: D1Database, actor: User, currentDigest: string): Promise<Response> {
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE sessions SET revoked_at_utc = ?
    WHERE user_id = ? AND token_digest != ? AND revoked_at_utc IS NULL`).bind(now, actor.id, currentDigest).run();
  await db.prepare(`INSERT INTO security_audit_events (id, actor_user_id, subject_user_id, event_type, created_at_utc)
    VALUES (?, ?, ?, 'provider_other_sessions_revoked', ?)`).bind(crypto.randomUUID(), actor.id, actor.id, now).run();
  return json({ ok: true, revokedCount: result.meta.changes });
}

async function familyLogin(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ pin: string }>(request);
  const pin = typeof body.pin === "string" && /^\d{6}$/.test(body.pin) ? body.pin : "";
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await rateLimit(env.DB, `family-pin-ip:${ip}`)) fail(429, "Too many attempts. Wait 15 minutes and try again.");
  const familyId = pin ? await verifyFamilyPin(env.DB, pin) : null;
  if (!familyId) fail(401, "Family PIN is incorrect.");
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE key_digest = ?")
    .bind(await digest(`family-pin-ip:${ip}`)).run();
  const family = await env.DB.prepare("SELECT id, display_name FROM families WHERE id = ? AND active = 1")
    .bind(familyId).first<{ id: string; display_name: string }>();
  if (!family) fail(401, "Family PIN is incorrect.");
  const pair = await createSession(env.DB, family.id, "family");
  return json({ user: { id: family.id, name: family.display_name, role: "family" } }, 200, sessionHeaders(pair, "family"));
}

async function providerRecovery(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ phrase: string; newPassword: string; confirmPassword: string }>(request);
  const password = validatePassword(body.newPassword);
  if (body.confirmPassword !== password) fail(400, "The passwords do not match.");
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const suppliedRecovery = typeof body.phrase === "string" ? body.phrase.trim() : "";
  const phraseLimit = await rateLimit(env.DB, `provider-recovery-phrase:${suppliedRecovery}:${ip}`);
  const ipLimit = await rateLimit(env.DB, `provider-recovery-ip:${ip}`);
  if (phraseLimit || ipLimit) fail(429, "Too many recovery attempts. Wait 15 minutes and try again.");
  const user = await env.DB.prepare(`SELECT id, active FROM users WHERE role = 'provider' AND active = 1 LIMIT 1`)
    .first<{ id: string; active: number }>();
  const stored = user ? await env.DB.prepare(`SELECT phrase_hash AS password_hash, salt, kdf_name, kdf_parameters_json
    FROM provider_recovery WHERE user_id = ?`).bind(user.id).first<CredentialRow>() : null;
  const phrase = suppliedRecovery.toUpperCase();
  const phraseValid = stored ? await verifyStoredSecret(stored, phrase) : false;
  const legacyDigest = await digest(suppliedRecovery);
  const legacyCode = !phraseValid && user ? await env.DB.prepare(`SELECT c.code_digest FROM account_recovery_codes c
    JOIN users u ON u.id = c.user_id WHERE c.code_digest = ? AND c.user_id = ? AND u.role = 'provider'
      AND c.used_at_utc IS NULL AND c.revoked_at_utc IS NULL`).bind(legacyDigest, user.id).first<{ code_digest: string }>() : null;
  if (!user?.active || (!phraseValid && !legacyCode)) {
    if (!stored && !legacyCode) await passwordHash(phrase, new Uint8Array(16));
    fail(400, "The recovery phrase is incorrect.");
  }

  const now = new Date().toISOString();
  const newPhrase = recoveryPhrase();
  const phraseSalt = randomBytes(16);
  const phraseHash = await passwordHash(newPhrase, phraseSalt);
  const passwordSalt = randomBytes(16);
  const passwordDigest = await passwordHash(password, passwordSalt);
  const resetStatements = [
    env.DB.prepare(`UPDATE credentials SET password_hash = ?, salt = ?, kdf_name = 'PBKDF2-SHA256',
      kdf_parameters_json = ?, updated_at_utc = ? WHERE user_id = ?`)
      .bind(toBase64(passwordDigest), toBase64(passwordSalt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now, user.id),
    env.DB.prepare(`UPDATE provider_recovery SET phrase_hash = ?, salt = ?, kdf_name = 'PBKDF2-SHA256',
      kdf_parameters_json = ?, updated_at_utc = ?, acknowledged_at_utc = NULL WHERE user_id = ?`)
      .bind(toBase64(phraseHash), toBase64(phraseSalt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now, user.id),
    env.DB.prepare("UPDATE sessions SET revoked_at_utc = ? WHERE user_id = ? AND revoked_at_utc IS NULL").bind(now, user.id),
    env.DB.prepare(`INSERT INTO security_audit_events (id, actor_user_id, subject_user_id, event_type, created_at_utc)
      VALUES (?, ?, ?, 'provider_account_recovered', ?)`).bind(crypto.randomUUID(), user.id, user.id, now),
  ];
  if (legacyCode) {
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE account_recovery_codes SET used_at_utc = ? WHERE code_digest = ? AND user_id = ?
        AND used_at_utc IS NULL AND revoked_at_utc IS NULL`).bind(now, legacyDigest, user.id),
      env.DB.prepare(`UPDATE credentials SET password_hash = ?, salt = ?, kdf_name = 'PBKDF2-SHA256',
        kdf_parameters_json = ?, updated_at_utc = ? WHERE user_id =
        (SELECT user_id FROM account_recovery_codes WHERE code_digest = ? AND used_at_utc = ?)`)
        .bind(toBase64(passwordDigest), toBase64(passwordSalt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now, legacyDigest, now),
      env.DB.prepare(`INSERT INTO provider_recovery
        (user_id, phrase_hash, salt, kdf_name, kdf_parameters_json, updated_at_utc, acknowledged_at_utc)
        SELECT user_id, ?, ?, 'PBKDF2-SHA256', ?, ?, NULL FROM account_recovery_codes
        WHERE code_digest = ? AND used_at_utc = ?
        ON CONFLICT(user_id) DO UPDATE SET phrase_hash = excluded.phrase_hash, salt = excluded.salt,
          kdf_name = excluded.kdf_name, kdf_parameters_json = excluded.kdf_parameters_json,
          updated_at_utc = excluded.updated_at_utc, acknowledged_at_utc = NULL`)
        .bind(toBase64(phraseHash), toBase64(phraseSalt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now, legacyDigest, now),
      env.DB.prepare(`UPDATE sessions SET revoked_at_utc = ? WHERE user_id =
        (SELECT user_id FROM account_recovery_codes WHERE code_digest = ? AND used_at_utc = ?) AND revoked_at_utc IS NULL`)
        .bind(now, legacyDigest, now),
      env.DB.prepare(`INSERT INTO security_audit_events (id, actor_user_id, subject_user_id, event_type, created_at_utc)
        SELECT ?, user_id, user_id, 'provider_account_recovered', ? FROM account_recovery_codes
        WHERE code_digest = ? AND used_at_utc = ?`).bind(crypto.randomUUID(), now, legacyDigest, now),
    ]);
    if (results[0]?.meta.changes !== 1) fail(400, "The recovery phrase is incorrect.");
  } else {
    await env.DB.batch(resetStatements);
  }
  const pair = await createSession(env.DB, user.id, "provider");
  return json({ recoveryPhrase: newPhrase }, 200, sessionHeaders(pair, "provider"));
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
    : `AND EXISTS (SELECT 1 FROM family_children fc WHERE fc.child_id = c.id AND fc.family_id = ? AND fc.active = 1)`;
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
    .bind(...(user.role === "provider" ? [] : [user.family_id])).all<ChildRow>();
  return result.results || [];
}

interface EventRow {
  id: string;
  child_id: string;
  child_name: string;
  family_id: string;
  family_name: string;
  actor_user_id: string;
  actor_name: string;
  action: string;
  occurred_at_utc: string;
  source: string;
  entry_reason: string | null;
  effective_child_id: string;
  effective_family_id: string;
  effective_action: string;
  effective_at_utc: string;
  correction_kind: string | null;
  replacement_child_name_snapshot: string | null;
  replacement_family_name_snapshot: string | null;
  correction_reason: string | null;
  correction_actor: string | null;
  created_at_utc: string;
  corrections_json: string;
  correction_history: Array<{ kind: string; reason: string; actor: string; createdAtUtc: string }>;
}

async function attendanceHistory(db: D1Database, user: User, limit?: number): Promise<EventRow[]> {
  const statement = db.prepare(`WITH latest_corrections AS (
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
      e.family_id, COALESCE(lc.replacement_family_name_snapshot, e.family_name_snapshot) AS family_name,
      e.actor_user_id, e.actor_name_snapshot AS actor_name,
      e.action, e.occurred_at_utc, e.source, e.entry_reason,
      COALESCE(lc.replacement_child_id, e.child_id) AS effective_child_id,
      COALESCE(lc.replacement_family_id, e.family_id) AS effective_family_id,
      COALESCE(lc.replacement_action, e.action) AS effective_action,
      COALESCE(lc.replacement_occurred_at_utc, e.occurred_at_utc) AS effective_at_utc,
      lc.correction_kind, lc.replacement_child_name_snapshot, lc.replacement_family_name_snapshot,
      lc.reason AS correction_reason, lc.actor_name_snapshot AS correction_actor,
      e.created_at_utc, COALESCE(ch.corrections_json, '[]') AS corrections_json
    FROM attendance_events e
    LEFT JOIN latest_corrections lc ON lc.attendance_event_id = e.id AND lc.rn = 1
    LEFT JOIN correction_history ch ON ch.attendance_event_id = e.id
    WHERE (? = 'provider' OR COALESCE(lc.replacement_family_id, e.family_id) = ?)
    ORDER BY e.occurred_at_utc DESC, e.created_at_utc DESC${limit === undefined ? "" : " LIMIT ?"}`);
  const result = limit === undefined
    ? await statement.bind(user.role, user.family_id).all<EventRow>()
    : await statement.bind(user.role, user.family_id, limit).all<EventRow>();
  return (result.results || []).map((row) => ({ ...row, correction_history: JSON.parse(row.corrections_json) }));
}

async function requireFamilyChild(db: D1Database, familyId: string, childId: string): Promise<void> {
  const row = await db.prepare(`SELECT 1 AS ok FROM family_children fc
    JOIN families f ON f.id = fc.family_id JOIN children c ON c.id = fc.child_id
    WHERE fc.family_id = ? AND fc.child_id = ? AND fc.active = 1 AND f.active = 1 AND c.active = 1`)
    .bind(familyId, childId).first<{ ok: number }>();
  if (!row) fail(403, "You are not authorized to manage this child.");
}

async function setup(request: Request, env: Env): Promise<Response> {
  if (!env.SETUP_SECRET) fail(503, "Setup is not configured. See the setup instructions.");
  const body = await bodyJson<{ setupSecret: string; email: string; name: string; password: string }>(request);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await rateLimit(env.DB, `first-provider-setup:${ip}`)) fail(429, "Setup is temporarily unavailable. Wait 15 minutes and try again.");
  const given = encoder.encode(String(body.setupSecret || ""));
  const expected = encoder.encode(env.SETUP_SECRET);
  if (!constantTimeEqual(await crypto.subtle.digest("SHA-256", given).then((x) => new Uint8Array(x)), await crypto.subtle.digest("SHA-256", expected).then((x) => new Uint8Array(x)))) {
    fail(401, "First-time setup could not be completed.");
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'provider'")
    .first<{ count: number }>();
  if ((count?.count || 0) > 0) fail(409, "The provider account is already set up.");
  const email = normalizeEmail(body.email);
  const name = requiredText(body.name, "name");
  const password = validatePassword(body.password);
  const userId = crypto.randomUUID();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const passwordSalt = randomBytes(16);
  const passwordDigest = await passwordHash(password, passwordSalt);
  const recoveryPhraseValue = recoveryPhrase();
  const recoverySalt = randomBytes(16);
  const recoveryDigest = await passwordHash(recoveryPhraseValue, recoverySalt);
  const pair = { token: base64Url(randomBytes(32)), csrf: base64Url(randomBytes(32)) };
  const sessionTokenDigest = await digest(pair.token);
  const sessionCsrfDigest = await digest(pair.csrf);
  const providerSession = sessionDurations("provider");
  const sessionExpires = new Date(nowDate.getTime() + providerSession.idleSeconds * 1000).toISOString();
  const sessionAbsoluteExpires = new Date(nowDate.getTime() + providerSession.absoluteSeconds * 1000).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, role, display_name, email_normalized, created_at_utc)
        VALUES (?, 'provider', ?, ?, ?)`)
        .bind(userId, name, email, now),
      env.DB.prepare(`INSERT INTO credentials
        (user_id, password_hash, salt, kdf_name, kdf_parameters_json, updated_at_utc)
        VALUES (?, ?, ?, 'PBKDF2-SHA256', ?, ?)`)
        .bind(userId, toBase64(passwordDigest), toBase64(passwordSalt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now),
      env.DB.prepare(`INSERT INTO provider_recovery
        (user_id, phrase_hash, salt, kdf_name, kdf_parameters_json, updated_at_utc, acknowledged_at_utc)
        VALUES (?, ?, ?, 'PBKDF2-SHA256', ?, ?, NULL)`)
        .bind(userId, toBase64(recoveryDigest), toBase64(recoverySalt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now),
      env.DB.prepare(`INSERT INTO security_audit_events (id, actor_user_id, subject_user_id, event_type, created_at_utc)
        VALUES (?, ?, ?, 'provider_initialized', ?)`)
        .bind(crypto.randomUUID(), userId, userId, now),
      env.DB.prepare(`INSERT INTO sessions
        (token_digest, csrf_digest, user_id, family_id, created_at_utc, expires_at_utc, absolute_expires_at_utc)
        VALUES (?, ?, ?, NULL, ?, ?, ?)`)
        .bind(sessionTokenDigest, sessionCsrfDigest, userId, now, sessionExpires, sessionAbsoluteExpires),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed:\s*users\.role/i.test(error instanceof Error ? error.message : "")) {
      fail(409, "The provider account is already set up.");
    }
    throw error;
  }
  return json({ ok: true, user: { id: userId, name, role: "provider", recoveryAcknowledgementRequired: true }, recoveryPhrase: recoveryPhraseValue }, 201, sessionHeaders(pair, "provider"));
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ email: string; password: string }>(request);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const accountLimit = await rateLimit(env.DB, `provider-login:${email}:${ip}`);
  const ipLimit = await rateLimit(env.DB, `provider-login-ip:${ip}`);
  if (accountLimit || ipLimit) fail(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
  const user = await env.DB.prepare(`SELECT id, NULL AS family_id, role, display_name, email_normalized, must_change_password
    FROM users WHERE email_normalized = ? AND active = 1 AND role = 'provider'`).bind(email).first<User>();
  const valid = user && password.length <= 256
    ? await verifyPassword(env.DB, user.id, password)
    : (await passwordHash(password.slice(0, 256), new Uint8Array(16)), false);
  if (!user || !valid) {
    fail(401, "Email or password is incorrect.");
  }
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE key_digest IN (?, ?)")
    .bind(await digest(`provider-login:${email}:${ip}`), await digest(`provider-login-ip:${ip}`)).run();
  const pair = await createSession(env.DB, user.id, "provider");
  const recovery = await env.DB.prepare("SELECT acknowledged_at_utc FROM provider_recovery WHERE user_id = ?")
    .bind(user.id).first<{ acknowledged_at_utc: string | null }>();
  return json({ user: { id: user.id, name: user.display_name, role: user.role, recoveryAcknowledgementRequired: !recovery?.acknowledged_at_utc } }, 200, sessionHeaders(pair, "provider"));
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

async function createFamily(request: Request, db: D1Database): Promise<Response> {
  const body = await bodyJson<{ name: string; childIds: string[] }>(request);
  const name = requiredText(body.name, "family name");
  const childIds = [...new Set((Array.isArray(body.childIds) ? body.childIds : []).map(assertId))];
  if (!childIds.length) fail(400, "Choose at least one child for this family.");
  for (const childId of childIds) {
    const child = await db.prepare("SELECT 1 FROM children WHERE id = ? AND active = 1").bind(childId).first();
    if (!child) fail(400, "Choose an active child.");
  }
  const familyId = crypto.randomUUID();
  const now = new Date().toISOString();
  const pin = await generateUniqueFamilyPin(db);
  const salt = randomBytes(16);
  const hash = await passwordHash(pin, salt);
  const statements = [
    db.prepare("INSERT INTO families (id, display_name, created_at_utc) VALUES (?, ?, ?)").bind(familyId, name, now),
    db.prepare(`INSERT INTO family_pin_credentials
      (family_id, pin_hash, salt, kdf_name, kdf_parameters_json, updated_at_utc)
      VALUES (?, ?, ?, 'PBKDF2-SHA256', ?, ?)`)
      .bind(familyId, toBase64(hash), toBase64(salt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now),
    ...childIds.map((childId) => db.prepare(`INSERT INTO family_children (family_id, child_id, created_at_utc)
      VALUES (?, ?, ?)`).bind(familyId, childId, now)),
  ];
  await db.batch(statements);
  return json({ id: familyId, name, pin }, 201);
}

async function resetFamilyPin(request: Request, db: D1Database, familyId: string): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (await rateLimit(db, `family-pin-reset:${familyId}:${ip}`)) {
    fail(429, "Too many PIN resets. Wait 15 minutes and try again.");
  }
  const family = await db.prepare("SELECT id FROM families WHERE id = ? AND active = 1")
    .bind(familyId).first<{ id: string }>();
  if (!family) fail(404, "Active family not found.");
  const pin = await generateUniqueFamilyPin(db, familyId);
  const salt = randomBytes(16);
  const hash = await passwordHash(pin, salt);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO family_pin_credentials
      (family_id, pin_hash, salt, kdf_name, kdf_parameters_json, updated_at_utc)
      VALUES (?, ?, ?, 'PBKDF2-SHA256', ?, ?)
      ON CONFLICT(family_id) DO UPDATE SET pin_hash = excluded.pin_hash, salt = excluded.salt,
        kdf_name = excluded.kdf_name, kdf_parameters_json = excluded.kdf_parameters_json,
        updated_at_utc = excluded.updated_at_utc`)
      .bind(familyId, toBase64(hash), toBase64(salt), JSON.stringify({ iterations: PBKDF2_ITERATIONS }), now),
    db.prepare("UPDATE sessions SET revoked_at_utc = ? WHERE family_id = ? AND revoked_at_utc IS NULL").bind(now, familyId),
  ]);
  return json({ pin });
}

async function updateFamily(request: Request, db: D1Database, id: string): Promise<Response> {
  const body = await bodyJson<{ name?: string; active?: boolean }>(request);
  const current = await db.prepare("SELECT display_name, active FROM families WHERE id = ?").bind(id)
    .first<{ display_name: string; active: number }>();
  if (!current) fail(404, "Family not found.");
  const name = body.name === undefined ? current.display_name : requiredText(body.name, "family name");
  if (body.active !== undefined && typeof body.active !== "boolean") fail(400, "Choose an active state.");
  const active = body.active === undefined ? current.active : body.active ? 1 : 0;
  const now = new Date().toISOString();
  await db.prepare(`UPDATE families SET display_name = ?, active = ?,
    deactivated_at_utc = CASE WHEN ? = 0 THEN COALESCE(deactivated_at_utc, ?) ELSE NULL END WHERE id = ?`)
    .bind(name, active, active, now, id).run();
  if (!active) await revokeFamilySessions(db, id);
  return json({ ok: true });
}

async function updateFamilyChildren(request: Request, db: D1Database, familyId: string): Promise<Response> {
  const body = await bodyJson<{ childIds: string[] }>(request);
  const family = await db.prepare("SELECT 1 FROM families WHERE id = ? AND active = 1").bind(familyId).first();
  if (!family) fail(404, "Family not found.");
  if (!Array.isArray(body.childIds) || body.childIds.length === 0) fail(400, "Choose at least one child for this family.");
  const childIds = [...new Set(body.childIds.map(assertId))];
  for (const childId of childIds) {
    const child = await db.prepare("SELECT 1 FROM children WHERE id = ? AND active = 1").bind(childId).first();
    if (!child) fail(400, "Choose an active child.");
  }
  const now = new Date().toISOString();
  const statements = [db.prepare(`UPDATE family_children SET active = 0, deactivated_at_utc = ?
    WHERE family_id = ? AND active = 1`).bind(now, familyId)];
  for (const childId of childIds) {
    statements.push(db.prepare(`INSERT INTO family_children (family_id, child_id, active, created_at_utc)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(family_id, child_id) DO UPDATE SET active = 1, deactivated_at_utc = NULL`)
      .bind(familyId, childId, now));
  }
  await db.batch(statements);
  return json({ ok: true });
}

async function recordAttendance(request: Request, db: D1Database, user: User): Promise<Response> {
  if (user.role !== "family" || !user.family_id) fail(403, "Family access required.");
  const body = await bodyJson<{ childId: string; action: "sign_in" | "sign_out"; requestId: string }>(request);
  const childId = assertId(body.childId);
  if (body.action !== "sign_in" && body.action !== "sign_out") fail(400, "Choose sign in or sign out.");
  const requestId = assertId(body.requestId);
  await requireFamilyChild(db, user.family_id, childId);
  const state = await childrenForUser(db, user);
  const child = state.find((item) => item.id === childId);
  if (!child) fail(404, "Child not found.");
  if ((body.action === "sign_in" && child.present) || (body.action === "sign_out" && !child.present)) {
    fail(409, "Attendance has changed. Refresh and try again.");
  }
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO attendance_events
      (id, child_id, child_name_snapshot, family_id, family_name_snapshot, actor_user_id, actor_name_snapshot,
       action, occurred_at_utc, source, request_id, created_at_utc)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'family', ?, ?)`)
      .bind(crypto.randomUUID(), childId, `${child.first_name} ${child.last_name}`, user.family_id,
        user.display_name, user.display_name, body.action, now, requestId, now).run();
  } catch {
    fail(409, "This attendance action was already recorded. Refresh the page.");
  }
  return json({ ok: true, occurredAtUtc: now }, 201);
}

async function recordAttendanceBatch(request: Request, db: D1Database, user: User): Promise<Response> {
  if (user.role !== "family" || !user.family_id) fail(403, "Family access required.");
  const body = await bodyJson<{ childIds: string[]; action: "sign_in" | "sign_out"; requestId: string }>(request);
  if (!Array.isArray(body.childIds) || body.childIds.length < 1 || body.childIds.length > 20) fail(400, "Choose between one and 20 children.");
  if (body.action !== "sign_in" && body.action !== "sign_out") fail(400, "Choose sign in or sign out.");
  const childIds = [...new Set(body.childIds.map(assertId))];
  if (childIds.length !== body.childIds.length) fail(400, "A child was selected more than once.");
  const requestId = assertId(body.requestId);
  const children = await childrenForUser(db, user);
  for (const childId of childIds) {
    await requireFamilyChild(db, user.family_id, childId);
    const child = children.find((item) => item.id === childId);
    if (!child || (body.action === "sign_in" && child.present) || (body.action === "sign_out" && !child.present)) {
      fail(409, "Attendance has changed. Refresh and try again.");
    }
  }
  const now = new Date().toISOString();
  const statements = childIds.map((childId, index) => {
    const child = children.find((item) => item.id === childId)!;
    return db.prepare(`INSERT INTO attendance_events
      (id, child_id, child_name_snapshot, family_id, family_name_snapshot, actor_user_id, actor_name_snapshot,
       action, occurred_at_utc, source, request_id, created_at_utc)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'family', ?, ?)`)
      .bind(crypto.randomUUID(), childId, `${child.first_name} ${child.last_name}`, user.family_id,
        user.display_name, user.display_name, body.action, now, `${requestId}-${index}`, now);
  });
  try { await db.batch(statements); }
  catch { fail(409, "Attendance changed while you submitted. Refresh and try again."); }
  return json({ ok: true, occurredAtUtc: now }, 201);
}

async function providerAttendance(request: Request, db: D1Database, user: User): Promise<Response> {
  await requireProvider(user);
  const body = await bodyJson<{ childId: string; familyId: string; action: "sign_in" | "sign_out"; reason: string; requestId: string }>(request);
  const childId = assertId(body.childId);
  const familyId = assertId(body.familyId);
  if (body.action !== "sign_in" && body.action !== "sign_out") fail(400, "Choose sign in or sign out.");
  const reason = requiredText(body.reason, "reason for provider entry", 1000);
  if (body.action === "sign_in") {
    await requireFamilyChild(db, familyId, childId);
  } else {
    const linked = await db.prepare(`SELECT 1 FROM family_children WHERE family_id = ? AND child_id = ?`)
      .bind(familyId, childId).first();
    if (!linked) fail(400, "Choose a family linked to this child.");
  }
  const children = await childrenForUser(db, user);
  const child = children.find((entry) => entry.id === childId);
  if (!child || (body.action === "sign_in" && child.present) || (body.action === "sign_out" && !child.present)) {
    fail(409, "Attendance has changed. Refresh and try again.");
  }
  const family = await db.prepare("SELECT display_name, active FROM families WHERE id = ?")
    .bind(familyId).first<{ display_name: string; active: number }>();
  if (!family || (body.action === "sign_in" && !family.active)) fail(400, "Choose an active family.");
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO attendance_events
      (id, child_id, child_name_snapshot, family_id, family_name_snapshot, actor_user_id, actor_name_snapshot,
       action, occurred_at_utc, source, request_id, created_at_utc, entry_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider', ?, ?, ?)`)
      .bind(crypto.randomUUID(), childId, `${child.first_name} ${child.last_name}`, familyId, family.display_name,
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
    familyId?: string;
    action?: "sign_in" | "sign_out";
    occurredAtUtc?: string;
  }>(request);
  const original = await db.prepare(`SELECT child_id, child_name_snapshot, family_id, family_name_snapshot, action, occurred_at_utc
    FROM attendance_events WHERE id = ?`).bind(eventId)
    .first<{ child_id: string; child_name_snapshot: string; family_id: string; family_name_snapshot: string; action: "sign_in" | "sign_out"; occurred_at_utc: string }>();
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
    const familyId = assertId(body.familyId || original.family_id);
    const action = body.action || original.action;
    const occurredAt = body.occurredAtUtc || original.occurred_at_utc;
    if (action !== "sign_in" && action !== "sign_out") fail(400, "Choose sign in or sign out.");
    if (!Number.isFinite(Date.parse(occurredAt))) fail(400, "Enter a valid event time.");
    const related = await db.prepare(`SELECT 1 FROM family_children WHERE family_id = ? AND child_id = ?`)
      .bind(familyId, childId).first();
    if (!related) fail(400, "That family is not linked to the selected child.");
    const childName = childId === original.child_id
      ? original.child_name_snapshot
      : await db.prepare("SELECT first_name || ' ' || last_name AS name FROM children WHERE id = ?").bind(childId).first<{ name: string }>().then((row) => row?.name);
    const familyName = familyId === original.family_id
      ? original.family_name_snapshot
      : await db.prepare("SELECT display_name AS name FROM families WHERE id = ?").bind(familyId).first<{ name: string }>().then((row) => row?.name);
    if (!childName || !familyName) fail(400, "Choose a valid child and family.");
    await db.prepare(`INSERT INTO attendance_corrections
      (id, attendance_event_id, correction_kind, replacement_child_id, replacement_child_name_snapshot,
       replacement_family_id, replacement_family_name_snapshot, replacement_action,
       replacement_occurred_at_utc, reason, actor_user_id, actor_name_snapshot, created_at_utc)
      VALUES (?, ?, 'replace', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), eventId, childId, childName, familyId, familyName, action,
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
  const columns = ["event_id", "child", "family", "action", "timestamp_utc", "original_action", "original_timestamp_utc", "source", "entry_reason", "actor", "correction", "correction_reason", "corrected_by", "correction_history_json"];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.id,
      row.child_name,
      row.family_name,
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
  await requireProvider(user);
  const body = await bodyJson<{ currentPassword: string; newPassword: string; confirmPassword: string }>(request);
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = validatePassword(body.newPassword);
  if (body.confirmPassword !== next) fail(400, "The passwords do not match.");
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
    db.prepare(`INSERT INTO security_audit_events (id, actor_user_id, subject_user_id, event_type, created_at_utc)
      VALUES (?, ?, ?, 'provider_password_changed', ?)`).bind(crypto.randomUUID(), user.id, user.id, now),
  ]);
  const pair = await createSession(db, user.id, "provider");
  return json({ ok: true }, 200, sessionHeaders(pair, "provider"));
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/downloads/")) {
      const fileName = providerDownloads[url.pathname];
      if (!fileName) return json({ error: "Not found." }, 404);
      return downloadProviderGuide(request, env, fileName);
    }
    if (!url.pathname.startsWith("/api/")) return asset(request, env.ASSETS);
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return json({ error: "Request not allowed." }, 403);
      if (request.method === "POST" && ["/api/setup", "/api/login", "/api/family-login", "/api/provider-recovery/complete"].includes(url.pathname) && origin !== url.origin) {
        return json({ error: "Request not allowed." }, 403);
      }
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/setup-status") {
        const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'provider'").first<{ count: number }>();
        return json({ setupRequired: (result?.count || 0) === 0 });
      }
      if (request.method === "POST" && url.pathname === "/api/setup") return await setup(request, env);
      if (request.method === "POST" && url.pathname === "/api/login") return await login(request, env);
      if (request.method === "POST" && url.pathname === "/api/family-login") return await familyLogin(request, env);
      if (request.method === "POST" && url.pathname === "/api/provider-recovery/complete") return await providerRecovery(request, env);

      const { row, user, recoveryAcknowledged } = await currentUser(request, env.DB);
      if (request.method === "POST" && url.pathname === "/api/logout") {
        if (user.role === "provider" && !recoveryAcknowledged) fail(403, "Save and acknowledge the recovery phrase before signing out.");
        await clearSession(request, env.DB);
        return json({ ok: true }, 200, clearedCookies());
      }
      if (request.method === "GET" && url.pathname === "/api/me") {
        return json({ user: { id: user.id, name: user.display_name, email: user.role === "provider" ? user.email_normalized : undefined, role: user.role,
          recoveryAcknowledgementRequired: user.role === "provider" && !recoveryAcknowledged } });
      }
      if (request.method === "POST" && url.pathname === "/api/password") return await changePassword(request, env.DB, user);
      if (request.method === "POST" && url.pathname === "/api/provider-recovery/ack") {
        await requireProvider(user);
        return await acknowledgeProviderRecovery(env.DB, user);
      }
      if (request.method === "POST" && url.pathname === "/api/provider-recovery/rotate") {
        await requireProvider(user);
        return await rotateProviderRecovery(env.DB, user, request);
      }
      if (request.method === "POST" && url.pathname === "/api/provider-sessions/revoke-others") {
        await requireProvider(user);
        return await revokeOtherProviderSessions(env.DB, user, row.token_digest);
      }
      if (user.role === "provider" && !recoveryAcknowledged && !["/api/me", "/api/provider-recovery/ack", "/api/provider-recovery/rotate"].includes(url.pathname)) {
        fail(403, "Save and acknowledge the provider recovery phrase before continuing.");
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
      if (request.method === "GET" && url.pathname === "/api/families") {
        await requireProvider(user);
        const families = await env.DB.prepare(`SELECT f.id, f.display_name AS name, f.active,
          CASE WHEN pc.family_id IS NOT NULL THEN 1 ELSE 0 END AS pin_set,
          GROUP_CONCAT(CASE WHEN fc.active = 1 THEN fc.child_id END) AS child_ids
          FROM families f LEFT JOIN family_pin_credentials pc ON pc.family_id = f.id
          LEFT JOIN family_children fc ON fc.family_id = f.id
          GROUP BY f.id ORDER BY f.display_name`).all();
        return json({ families: families.results || [] });
      }
      if (request.method === "POST" && url.pathname === "/api/families") {
        await requireProvider(user);
        return await createFamily(request, env.DB);
      }
      const familyPinMatch = url.pathname.match(/^\/api\/families\/([A-Za-z0-9_-]+)\/reset-pin$/);
      if (request.method === "POST" && familyPinMatch) {
        await requireProvider(user);
        return await resetFamilyPin(request, env.DB, familyPinMatch[1]);
      }
      const familySessionsMatch = url.pathname.match(/^\/api\/families\/([A-Za-z0-9_-]+)\/revoke-sessions$/);
      if (request.method === "POST" && familySessionsMatch) {
        await requireProvider(user);
        const family = await env.DB.prepare("SELECT id FROM families WHERE id = ?").bind(familySessionsMatch[1]).first();
        if (!family) fail(404, "Family not found.");
        return json({ ok: true, revokedCount: await revokeFamilySessions(env.DB, familySessionsMatch[1]) });
      }
      const familyChildrenMatch = url.pathname.match(/^\/api\/families\/([A-Za-z0-9_-]+)\/children$/);
      if (request.method === "PUT" && familyChildrenMatch) {
        await requireProvider(user);
        return await updateFamilyChildren(request, env.DB, familyChildrenMatch[1]);
      }
      const familyMatch = url.pathname.match(/^\/api\/families\/([A-Za-z0-9_-]+)$/);
      if (request.method === "PATCH" && familyMatch) {
        await requireProvider(user);
        return await updateFamily(request, env.DB, familyMatch[1]);
      }
      if (request.method === "GET" && url.pathname === "/api/attendance") return json({ events: await attendanceHistory(env.DB, user, 500) });
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
