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

The QR code points to a shared, non-secret app URL only. It contains no child, guardian, or attendance identifiers. Each adult must sign in as themselves; the server resolves their authorized children and stamps attendance using server time. A parent request must never be allowed to select an arbitrary child or actor.

For portability, account ownership, the Cloudflare zone, Worker, D1 database, and backup credentials belong to the daycare provider. Avoid developer-owned integrations and hardcoded account identifiers. Current free-tier quotas should be checked during handoff; do not promise permanent $0 hosting.

## Initial database schema

Migration: `migrations/0001_initial_schema.sql`.

| Table | Purpose and key safeguards |
| --- | --- |
| `children` | Child display name and active/deactivated state. Keep rows referenced by history. |
| `guardians` | Authorized adult records and active state. |
| `guardian_children` | Many-to-many authorization links; only active links authorize a guardian for a child. |
| `users` | Login identity and role (`provider` or `guardian`); guardian account links to a guardian record and can be marked to require a password change. |
| `credentials` | Derived password hash and salt only; never plaintext password or PIN. Parameters identify the KDF settings. |
| `sessions` | Digests of a random session token and CSRF token, expiry and revocation time; raw session token is not stored. |
| `auth_rate_limits` | Hashed rate-limit key, attempt window and lockout expiry; do not persist raw IP or email as the key. |
| `attendance_events` | Immutable sign-in/out facts: child and guardian name snapshots, actor, action, server timestamp, source and idempotency key. |
| `attendance_corrections` | Append-only void/replacement with original event, replacement fields and name snapshots, reason, actor, and correction time. |

All persisted timestamps use UTC ISO-8601 text. UI and printable reports display `America/Chicago`. No automatic attendance purge is included; choose a retention policy with the provider before production. Append-only triggers prevent ordinary SQL updates/deletes to attendance and correction rows; database administrators can still alter a database, so protected backups and account access are part of the audit design. Name snapshots keep event history stable if a child or guardian's profile is later edited.

The event stream stores every sign-in/out action rather than overwriting a daily row. “Currently present” is a derived view after applying the latest valid correction per event and resolving each child's sequence. Corrections must record a reason and the provider actor. If a correction changes the child/guardian identity, both the original and replacement remain visible in audit reports.

## Security decisions to validate during implementation

- Use a vetted password KDF available in Workers (for example, Web Crypto PBKDF2 with reviewed parameters) and random, high-entropy opaque session cookies. Store only credential hashes and token digests.
- Set session cookies `Secure`, `HttpOnly`, and `SameSite`; expire sessions and support revocation. Add CSRF defenses for cookie-authenticated writes.
- Rate-limit login attempts in D1. Use generic login failure responses and avoid sensitive logs.
- Validate and authorize every request server-side. Guardian access is restricted by current active guardian-child links; provider operations require provider role.
- Provider account recovery must be doable without the original developer or an undisclosed email/SMS account. Define and document safe recovery, enrollment, and revocation before launch.
- Generate attendance timestamps on the Worker, never trust client clocks. Add an idempotency key to prevent repeat scans from generating duplicate events.
- Provide downloadable CSV and printable reports that preserve original event details and correction history. Make record count/date limits clear to the provider.
- Establish encrypted, provider-controlled D1 backups and practice restoring into a separate database before real use. Make the current retention horizon visible to the provider.

## Excluded scope

CCAP compliance and electronic attendance submission are not project requirements. Do not add Provider Hub integration or claim compliance. The app remains an operational attendance tool; review applicable licensing and privacy obligations separately before production use.

## Implementation roadmap

1. **Foundation (implemented locally):** Worker, responsive UI, D1 migration, local setup documentation.
2. **Accounts and authorization (initial implementation):** provider bootstrap, guardian enrollment, password hashing, session cookies, rate limiting, deactivation, server-side role/relationship checks, and CSRF token checks. Review and harden before production.
3. **Attendance (initial implementation):** server-timestamped sign-in/out events, sibling flow, current-presence projection, idempotency keys, and append-only corrections with reason and actor.
4. **Provider workflows (initial implementation):** child/guardian add, edit and deactivation, guardian-child management, latest-500 attendance history, CSV export, and print view. Add filters and pagination before relying on long-term exports.
5. **Operational readiness (not implemented):** provider account recovery, configurable retention policy, encrypted backups and restore drill, access recovery guide, developer access revocation, accessibility and security review.
6. **Launch readiness:** complete the operational work, transfer all infrastructure to the daycare-owned Cloudflare account, and prepare a provider-friendly deployment and recovery manual.

No production infrastructure or public deployment is created by this project setup.
