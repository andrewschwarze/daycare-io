# Megan's Childcare Attendance

A mobile-first attendance app for one in-home childcare program. Families use one shared six-digit PIN to access their linked children, while the provider manages attendance and family access.

> **Development status:** This is an early local implementation. Use fictional children and families only. Review authentication, backups, recovery, privacy, and deployment before entering real attendance data.

## Architecture

- One Cloudflare Worker serves the responsive static UI and JSON API.
- Cloudflare D1 stores provider accounts, family-child authorization, attendance events, and corrections.
- TypeScript is used for the Worker. The browser UI uses small dependency-free JavaScript and CSS assets.
- Provider passwords and family PINs use PBKDF2-derived hashes with unique salts. Session and CSRF tokens are stored only as digests. Cookie-authenticated writes include a CSRF token.
- Each family uses a unique six-digit PIN and can stay signed in on a trusted phone for 30 days. Providers can generate replacement PINs and revoke trusted sessions.
- Provider account recovery uses a one-time recovery phrase. There is no email recovery service or permanent setup backdoor.
- Attendance is appended as events. Corrections are separate records with a reason and provider identity; original events remain in the database.
- No email delivery, analytics, or third-party identity provider is used. Family PINs are displayed once to the provider when first generated or reset and should be shared privately.

The intended hosting target is Cloudflare's free tiers at expected low usage, but $0 is not guaranteed. Check current quotas and pricing in an account owned by the childcare provider.

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

3. Apply the local database migrations (the latest migration performs a complete local test-data refresh):

   ```powershell
   npx wrangler d1 migrations apply daycare-attendance-local --local
   ```

4. Start the app:

   ```powershell
   npm run dev
   ```

5. Open the local URL printed by Wrangler, usually `http://localhost:8787`. Create the provider account with the setup code from `.dev.vars`.

The first provider account can add children and families. Save the provider's one-time recovery phrase displayed during setup in a secure password manager or print it and store it safely. Acknowledge that it has been saved to finish setup. To add a family, choose its children; the app generates a unique six-digit family PIN and displays it once. Share it privately with the family.

## Current features

- Provider account bootstrap, password login, and one-time recovery phrase
- Shared family six-digit PIN sign-in, with server-enforced family-child links
- 30-day family sessions; 12-hour provider idle sessions with 30-day maximum lifetime
- Family check-in/check-out for linked children, with server-generated UTC timestamps
- A shared parent entry URL that can be used in a QR code without embedding child information
- Provider child/family add, edit, deactivate, and access management
- Provider password change, recovery, other-device revocation, family PIN reset, and family-device revocation
- Provider attendance history, append-only void/replacement corrections, CSV export, and print view
- Times shown in `America/Chicago`

## Scope and limits

CCAP compliance, electronic attendance submission, and state-specific reporting are out of scope. This app is for the childcare program's own attendance operations. Provider policies and applicable licensing/privacy obligations should still be reviewed before real records are entered.

The dashboard activity feed shows the latest 500 events; CSV export includes the full attendance history. Date filtering is not yet available. The everyday provider instructions are in [docs/provider-guide.md](docs/provider-guide.md), and technical operations are in [docs/technical-provider-guide.md](docs/technical-provider-guide.md). The provider dashboard has authenticated links to both Word guides. Regenerate them from the Markdown sources with `python docs/build_provider_guides.py` after installing the optional `python-docx` package. Family PINs are shown only once when generated or reset. A provider who loses both the password and recovery phrase has no in-app recovery path. Backup and restore still need a provider-owned production setup and a successful restore drill. Attendance rows are not automatically purged; set an appropriate retention policy before production. Do not deploy publicly or enter real family information yet.

See [docs/architecture.md](docs/architecture.md) for the schema, security direction, exclusions, and implementation roadmap. See [AGENTS.md](AGENTS.md) for development guidelines.
