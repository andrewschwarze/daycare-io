# Technical Provider Guide

Megan's Daycare  
Technical operations reference  
Updated November 2026

This guide is for the daycare's authorized technical operator. It covers local development, Cloudflare D1 operations, account recovery, backup and restore, and provider handoff. The repository is still an early prototype. No production infrastructure has been created, and real child or family data must not be entered until launch requirements are implemented and tested.

## System overview

The app uses one Cloudflare Worker for the TypeScript API and static frontend. Cloudflare D1 stores the provider account, family PIN credentials, family-child links, attendance events, and append-only corrections. The browser assets are dependency-light JavaScript and CSS.

Migrations `0001` through `0004` are historical. Migration `0005_family_pin_auth.sql` is the current full-refresh schema migration: it drops all previous app records and creates the family PIN schema. Apply it only to a database whose contents are authorized for complete deletion. UTC ISO-8601 timestamps are stored; the interface formats times in `America/Chicago`. Attendance events store name snapshots and actor identity. Corrections require a reason and actor, and do not overwrite original events. Children and families are deactivated rather than deleted.

The Worker configuration in `wrangler.toml` currently uses a local placeholder D1 identifier. There is no provider-owned production database or public deployment in this repository state. Do not use a local database for real information.

## Local development

Use a supported Node.js LTS release and npm. The local app requires no Cloudflare account. Use only fictional children, adults, emails, and attendance.

1. Install project packages with `npm install`.
2. If `.dev.vars` does not exist, copy `.dev.vars.example` to `.dev.vars` and set a long, random local setup secret. Never overwrite or print an existing `.dev.vars` file. It is ignored by Git.
3. Apply the local migration with `npx wrangler d1 migrations apply daycare-attendance-local --local`.
4. Run `npm run dev` and open the local URL, normally `http://localhost:8787`.
5. Create the local provider account using the local setup secret. Keep all test data fictional.

Before submitting code changes, run `npm run typecheck` and `node --check public/app.js`. Do not point local Wrangler at a production D1 database for routine development. Do not put real records in screenshots, fixtures, pull requests, logs, or bug reports.

## Authentication and account recovery

### Family PINs and sessions

Each family shares one unique six-digit PIN. The provider adds a family and links its children; the Worker generates a PIN, hashes it with PBKDF2-SHA256 and a unique salt, and displays it once. The provider shares the PIN privately. The app has no individual guardian accounts, email dependency, PIN change flow, enrollment codes, or family recovery flow. If a PIN is forgotten or exposed, generate a replacement in the provider dashboard; the previous PIN is invalidated and all family sessions are revoked. A provider can also revoke sessions without changing the PIN.

The Worker checks family status and family-child links on every protected request. Family PIN attempts are rate-limited by IP; login failures are generic. Family sessions last up to 30 days and can be explicitly signed out or revoked by the provider. Provider sessions expire after 12 hours idle and have a 30-day absolute maximum. The Worker stores session and CSRF token digests and issues Secure, HTTP-only, SameSite cookies.

### Provider password and recovery phrase

The provider keeps a strong password. During first setup, the app generates a 160-bit recovery phrase in grouped characters, stores only a salted PBKDF2 hash, and displays it once. The provider must acknowledge saving it before using the dashboard. Store the phrase securely and separately from the password. A signed-in provider can generate a replacement phrase; the old phrase becomes invalid when the replacement is acknowledged.

If the provider forgets the password, choose **Provider sign in**, then **I need to recover provider access**. Enter the phrase and choose a new password. The app revokes all provider sessions, replaces the phrase, signs in the provider, and requires acknowledgment of the replacement before restoring dashboard access. Recovery attempts are rate-limited. A used phrase cannot be reused. Recovery does not use email, SMS, or the initial setup keyword.

During migration from the previous recovery-code version, existing provider recovery codes remain usable until the replacement phrase is acknowledged. A successful legacy-code recovery also issues a replacement phrase. Once the phrase is acknowledged, old recovery codes are revoked. The initial setup keyword can only create the first provider account; it cannot create another provider or recover an account.

The local test database was cleared before applying the family PIN redesign. Never run a destructive reset or apply `0005` to staging or production unless the provider has explicitly approved deleting every record in that exact database. No attempt to preserve or migrate legacy guardian accounts is included.

If the provider loses both password and recovery phrase after any remaining legacy codes are retired, there is no in-app recovery route. Do not create a permanent master password or edit credential rows manually. Use the secure paper attendance process while an authorized technical operator follows a controlled recovery process. Cloudflare account recovery does not recover an app account.

Before production, run authentication tests, verify session expiration and revocation, confirm family authorization boundaries, and verify that PINs and recovery secrets are not exposed through API responses or logs. Keep recovery materials under daycare ownership.

## Provider dashboard operations

Use the everyday guide in `docs/provider-guide.md` for provider tasks. The provider dashboard supports child and family creation, edits, deactivation, child relationships, PIN replacement and device revocation, provider-recorded attendance, event corrections, CSV export, and print view.

Provider-recorded events use server time, identify the provider as actor, and require a reason. A corrected time is appended as a correction; the original event remains. The CSV contains the full event history but is not a database backup and is not an external reporting submission.

The dashboard links to two Word guides. Their source files are in `docs/`; regenerate the documents with `python docs/build_provider_guides.py` using a Python environment with `python-docx` installed. The generated files are in `public/downloads/` and are served only through provider-authenticated download routes. Keep the guides free of actual credentials or family data.

## D1 migrations

Treat every schema change as a new migration. Never rewrite an existing migration that may have been applied. Apply migrations locally first against fictional local data. Review the SQL and confirm the exact account and database before applying any production migration. No production migration should be run until the provider explicitly approves that release.

Local migration command:

```powershell
npx wrangler d1 migrations apply daycare-attendance-local --local
```

For a future provider-owned production database, use the exact configured database name and an explicit remote flag only after approval:

```powershell
npx wrangler d1 migrations apply replace-with-provider-database-name --remote
```

## Backup policy

The CSV export omits account credentials, sessions, authorization links, and other configuration. It cannot restore the app. Full D1 SQL exports include personal information and password hashes; treat them as highly sensitive. Never commit exports, place them in this repository, send them by email, or store them on an unencrypted drive.

D1 Time Travel is automatic short-term recovery, not a six-year archive. As of November 2026, Cloudflare documents seven days of history on the Free plan and 30 days on the Paid plan. Confirm the current plan and limits before production. See [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

Before production, the provider must approve a backup schedule and protected storage that supports the daycare's six-year retention plan. A monthly full export is a reasonable starting schedule for a single in-home daycare, subject to the provider's recordkeeping needs. Store exports on provider-controlled encrypted media, keep a second encrypted copy in a separate secure location, and record only backup metadata in the backup log. Do not retain unnecessary copies longer than the provider's approved retention policy.

Example Windows PowerShell export from the project folder. Replace the database name. Connect an encrypted provider-owned drive first.

```powershell
$backupRoot = "E:\MeganDaycareBackups"
$databaseName = "replace-with-provider-database-name"
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupFile = Join-Path $backupRoot "attendance-$stamp.sql"
npx wrangler d1 export $databaseName --remote --output $backupFile
if ((Get-Item $backupFile).Length -eq 0) { throw "The backup file is empty." }
Get-Item $backupFile | Select-Object Name, Length, LastWriteTime
```

Follow the current [Cloudflare D1 export and import instructions](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and [Wrangler D1 command reference](https://developers.cloudflare.com/workers/wrangler/commands/d1/).

## Restore after a recent error

Time Travel restoration overwrites the current database with an earlier state. Newer events may disappear from the live database. Do not run a restore as a test.

1. Tell families to stop using the app and switch to the secure paper attendance process.
2. Confirm the provider-owned database name and the restore time before the data problem.
3. Export the current database to protected storage first.
4. Inspect the candidate restore point, then obtain provider approval before restoring.
5. Validate provider access, child and family records, attendance, and corrections before reopening the app.
6. Record the reason, time, target database, backup file, and previous bookmark in the protected backup log.

```powershell
$databaseName = "replace-with-provider-database-name"
$restoreTime = "replace-with-restore-time-in-UTC"
npx wrangler d1 time-travel info $databaseName --timestamp $restoreTime
# Run only after the provider confirms the database and restore point.
npx wrangler d1 time-travel restore $databaseName --timestamp $restoreTime
```

Keep the previous bookmark returned by the restore command; Cloudflare documents that it can be used to undo the restore. Review the current [Time Travel restore procedure](https://developers.cloudflare.com/d1/reference/time-travel/) before taking action.

## Restore a full SQL export

Restore only into a new, empty D1 database owned by the daycare. Never import a production export into the ordinary local development database. Production data must not be copied to a developer device or a development environment that is reserved for fictional data.

```powershell
$databaseName = "replace-with-new-empty-provider-database-name"
$backupFile = "E:\MeganDaycareBackups\attendance-YYYYMMDD-HHMM.sql"
npx wrangler d1 execute $databaseName --remote --file $backupFile
```

Validate the imported database in a restricted provider-owned environment before directing the live Worker to it. Preserve the former database until the provider confirms that the replacement is correct. Changing the Worker binding or deploying a replacement is a separate production change and requires provider approval.

## Production handoff

Before launch, confirm that the Cloudflare account, Worker, D1 database, domain, source repository, and recovery materials are owned by the daycare. The placeholder database ID in `wrangler.toml` must be replaced with the provider-owned database ID during authorized setup. Production secrets must be stored as Cloudflare secrets and must not be committed to Git.

Verify provider and family PIN login, family authorization boundaries, sign-in/out, corrections, provider-only downloads, CSV export, backup, and restore. Confirm provider password recovery is implemented and tested. Confirm the provider can administer families without developer access.

After the provider verifies control and recovery, remove developer members and tokens from the Cloudflare account and repository, rotate any shared setup or deployment credentials, and confirm the provider can still administer the system. Never remove provider access or disable backups during handoff.

## Current launch blockers

- Provider recovery phrase is implemented; verify it is stored securely. A separate technical recovery path is still needed if the provider loses both password and phrase.
- No provider-owned production account, Worker, or D1 database is configured.
- A protected backup schedule and successful restore drill have not been completed.
- Retention policy, security review, and developer-access revocation remain to be completed.

Keep the app in fictional-data development until each blocker is resolved and verified.
