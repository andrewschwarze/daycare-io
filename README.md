# Daycare Attendance

A mobile-first attendance app starter for one licensed in-home daycare in Minnesota. It provides individual guardian accounts, parent-operated sign-in/out, provider administration, and an auditable attendance history.

> **Development status:** This is an early local implementation. Use fictional children and guardians only. Review authentication, backups, recovery, privacy, and deployment before entering real attendance data.

## Architecture

- One Cloudflare Worker serves the responsive static UI and JSON API.
- Cloudflare D1 stores user accounts, guardian-child authorization, attendance events, and corrections.
- TypeScript is used for the Worker. The browser UI uses small dependency-free JavaScript and CSS assets.
- Passwords are stored as PBKDF2-derived hashes; session tokens are random and only their digests are stored. Cookie-authenticated writes include a CSRF token.
- Attendance is appended as events. Corrections are separate records with a reason and provider identity; original events remain in the database.
- No email, analytics, or third-party identity provider is used. A guardian gets a temporary password to receive privately and must change it after first sign-in.

The intended hosting target is Cloudflare's free tiers at expected low usage, but $0 is not guaranteed. Check current quotas and pricing in an account owned by the daycare provider.

## Local setup

Requirements: Node.js LTS and npm. No Cloudflare account is required for the local development database.

1. Install packages:

   ```powershell
   npm install
   ```

2. Create a local one-time provider setup code. Copy `.dev.vars.example` to `.dev.vars` and replace the sample value with a long random secret. Keep `.dev.vars` private; it is ignored by Git.

   ```powershell
   Copy-Item .dev.vars.example .dev.vars
   ```

3. Apply the local database migration:

   ```powershell
   npx wrangler d1 migrations apply daycare-attendance-local --local
   ```

4. Start the app:

   ```powershell
   npm run dev
   ```

5. Open the local URL printed by Wrangler, usually `http://localhost:8787`. Create the provider account with the setup code from `.dev.vars`.

The first provider account can add children and guardian accounts. The app displays a guardian's temporary password once; share it privately. The guardian must replace it at first sign-in.

## Current features

- Provider account bootstrap and password login
- Individual guardian accounts and child access links
- Guardian check-in/check-out for linked children, with server-generated UTC timestamps
- A shared parent entry URL that can be used in a QR code without embedding child information
- Provider child/guardian add, edit, deactivate, and access management
- Provider attendance history, append-only void/replacement corrections, CSV export, and print view
- Times shown in `America/Chicago`

## Scope and limits

CCAP compliance, electronic attendance submission, and state-specific reporting are out of scope. This app is for the daycare's own attendance operations. Provider policies and applicable licensing/privacy obligations should still be reviewed before real records are entered.

History and CSV currently return the latest 500 events; date filtering and full-history export remain to be added. Production deployment, account recovery, backup/restore procedures, and the nontechnical provider manual remain roadmap work. Attendance rows are not automatically purged; set an appropriate retention policy before production. Do not deploy publicly or enter real family information yet.

See [docs/architecture.md](docs/architecture.md) for the schema, security direction, exclusions, and implementation roadmap. See [AGENTS.md](AGENTS.md) for development guidelines.
