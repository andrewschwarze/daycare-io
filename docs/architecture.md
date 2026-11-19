# Initial architecture, schema, and roadmap

## Repository inspection

The repository was empty at setup: no application files, migrations, or project conventions were present. The Git remote points at `andrewschwarze/daycare-io`; the GitHub repository had no source content at inspection time.

## Proposed architecture

Use one Cloudflare Worker for the API and static frontend, with D1 as the only production data store. Keep the browser UI as small static assets and avoid a separate frontend hosting service, identity SaaS, analytics, or messaging provider until a concrete need justifies their cost and handoff burden.

```text
Parent phone / Provider browser
          |
          v
Cloudflare Worker (static UI + authenticated JSON API)
          |
          v
Cloudflare D1 (accounts, relationships, attendance, audit trail)
```

The QR code points to a shared, non-secret app URL only. It contains no child, family, or attendance identifiers. A family enters its shared six-digit PIN; the server resolves only that family's active children and stamps attendance using server time. A family request must never be allowed to select an arbitrary child or actor.

For portability, account ownership, the Cloudflare zone, Worker, D1 database, and backup credentials belong to the childcare provider. Avoid developer-owned integrations and hardcoded account identifiers. Current free-tier quotas should be checked during handoff; do not promise permanent $0 hosting.

## Initial database schema

Migrations `0001`–`0004` are retained as historical migrations. `0005_family_pin_auth.sql` intentionally drops all prior test application data and creates the current provider/family schema. It must be applied only after the database is intended to be fully refreshed; the user explicitly authorized a complete test-data reset for this authentication redesign.

| Table | Purpose and key safeguards |
| --- | --- |
| `children` | Child display name and active/deactivated state. Keep rows referenced by history. |
| `families` | Family display name and active/deactivated state. |
| `family_children` | Many-to-many authorization links; only active links authorize a family for a child. |
| `users` | Provider login identity only. Family access is represented by a family-bound session, not an individual user account. |
| `credentials` | Provider's derived password hash and salt only. Never store family PINs in plaintext. |
| `family_pin_credentials` | Derived unique family PIN hash, salt, and KDF parameters. PINs are generated and shown once by the provider. |
| `provider_recovery` | Salted PBKDF2 hash of the current provider recovery phrase and acknowledgment time. |
| `sessions` | Digests of random session and CSRF tokens, sliding idle expiry, absolute expiry, and revocation time; raw tokens are not stored. |
| `auth_rate_limits` | Hashed rate-limit key, attempt window and lockout expiry; do not persist raw IP or email as the key. |
| `security_audit_events` | Append-only account security events without PINs, passwords, recovery phrases, or enrollment codes. |
| `account_recovery_codes` | Single-use recovery code digests, user, issue/use/revocation times; never store the raw code. |
| `account_security_events` | Append-only record of recovery-code issue and provider password recovery, without secrets. |
| `attendance_events` | Immutable sign-in/out facts: child and family name snapshots, actor, action, server timestamp, source and idempotency key. |
| `attendance_corrections` | Append-only void/replacement with original event, replacement fields and name snapshots, reason, actor, and correction time. |

All persisted timestamps use UTC ISO-8601 text. UI and printable reports display `America/Chicago`. No automatic attendance purge is included; choose a retention policy with the provider before production. Append-only triggers prevent ordinary SQL updates/deletes to attendance and correction rows; database administrators can still alter a database, so protected backups and account access are part of the audit design. Name snapshots keep event history stable if a child or family's profile is later edited.

The event stream stores every sign-in/out action rather than overwriting a daily row. “Currently present” is a derived view after applying the latest valid correction per event and resolving each child's sequence. Corrections must record a reason and the provider actor. If a correction changes the child/family identity, both the original and replacement remain visible in audit reports.

## Security decisions to validate during implementation

- Use Web Crypto PBKDF2-SHA256 with per-credential salts and high-entropy opaque session cookies. Cloudflare Workers rejects PBKDF2 iteration counts above 100,000, so the current derivation uses that ceiling; review this platform constraint and the password-hashing choice during the pre-launch security review. Store only credential hashes and token digests. Family PINs are six digits; rate limits, unique PIN generation, and device revocation mitigate online guessing and compromise risk.
- Set session cookies `Secure`, `HttpOnly`, and `SameSite`; expire sessions and support revocation. Add CSRF defenses for cookie-authenticated writes.
- Rate-limit family PIN guessing and provider login/recovery in D1; apply IP and account limits where applicable. Use generic login failure responses and avoid sensitive logs.
- Validate and authorize every request server-side. Family access is restricted by current active family-child links; provider operations require provider role.
- A provider can generate a family PIN once or replace it; replacement revokes family sessions. Provider recovery uses a one-time recovery phrase and keeps legacy provider recovery codes as a transition path until the new phrase is acknowledged. Define a safe fallback for a provider who loses both password and recovery phrase before launch.
- Generate attendance timestamps on the Worker, never trust client clocks. Add an idempotency key to prevent repeat scans from generating duplicate events.
- Provide downloadable CSV and printable reports that preserve original event details and correction history. Make record count/date limits clear to the provider.
- Establish encrypted, provider-controlled D1 backups and practice restoring into a separate database before real use. Make the current retention horizon visible to the provider.

## Excluded scope

CCAP compliance and electronic attendance submission are not project requirements. Do not add Provider Hub integration or claim compliance. The app remains an operational attendance tool; review applicable licensing and privacy obligations separately before production use.

## Implementation roadmap

1. **Foundation (implemented locally):** Worker, responsive UI, D1 migration, local setup documentation.
2. **Accounts and authorization (family PIN redesign in progress):** provider bootstrap, provider password hashing, family PIN authentication, session cookies, rate limiting, deactivation, server-side role/relationship checks, and CSRF token checks. Review and harden before production.
3. **Attendance (initial implementation):** server-timestamped sign-in/out events, sibling flow, current-presence projection, idempotency keys, and append-only corrections with reason and actor.
4. **Provider workflows (initial implementation):** child/family add, edit and deactivation, family-child management, latest-500 attendance history, CSV export, and print view. Add filters and pagination before relying on long-term exports.
5. **Operational readiness (partially implemented):** the provider can generate/reset family PINs and revoke family devices. Provider recovery phrases and trusted-session lifetimes are implemented. A provider who loses both the password and recovery phrase still has no in-app recovery path. Configurable retention, encrypted provider-owned backups and a restore drill, developer access revocation, and accessibility and security review remain outstanding.
6. **Launch readiness:** complete the operational work, transfer all infrastructure to the childcare-owned Cloudflare account, and review both provider guides with the provider. Word copies are served from authenticated provider-only download routes.

No production infrastructure or public deployment is created by this project setup.
