# Development and security guidelines

## Product scope

- Build for one licensed in-home daycare in Minnesota. Keep routine provider administration in the application.
- Keep the design mobile-first, accessible, and understandable by a nontechnical provider.
- Keep the deployment portable to a Cloudflare account owned by the daycare provider. Never bake in developer account IDs, tokens, or credentials.
- Use fictional children and adults in source, documentation, screenshots, and local fixtures. Never copy real attendance or family information into development.
- Do not add CCAP-specific workflows or claim state-program compliance; CCAP reporting is outside this project's scope.

## Technical direction

- Use TypeScript for Cloudflare Worker code, Cloudflare D1 for durable records, and small dependency-light browser assets.
- Validate all input and enforce authorization in server-side Worker handlers. The browser is not an authorization boundary.
- Store timestamps as UTC ISO-8601 values. Convert to `America/Chicago` only for display and reports.
- Keep attendance events and correction records append-only. Never overwrite or silently remove historical attendance. Corrections require a reason and the authenticated actor.
- Use soft deactivation for children and guardians. Do not cascade-delete attendance history.
- Avoid external services unless a specific requirement cannot be met with Cloudflare and a provider-owned account. Document any such dependency and its recurring cost.

## Security and privacy

- Never store plaintext passwords, PINs, session tokens, or recovery codes. Store only appropriately derived credential hashes or token digests.
- Use secure, HTTP-only, SameSite cookies for sessions; enforce CSRF protection for state-changing cookie-authenticated requests.
- Add server-side rate limits to authentication and sensitive actions. Return generic authentication errors and avoid logging names, credentials, session tokens, or attendance details.
- Check the session, role, active state, and guardian-child relationship on every protected request. Do not trust child IDs sent by the browser.
- Keep children's information out of QR codes, URLs, analytics, and error messages.
- Use least-privilege account access, encrypted transport, and protected backups. Document backup restoration and account recovery.
- Keep local development data fictional and never represent the development database as production-safe.

## Change workflow

- Keep architecture, schema, roadmap, and handoff instructions documented in the repository.
- Do not deploy publicly or create production Cloudflare resources without an explicit request.
- When adding a dependency, explain why it is needed and prefer a maintained, minimal option.
- Treat schema changes as migrations. Preserve old migrations and never rewrite a migration that may have been applied.
- Provide clear setup and recovery steps suitable for a nontechnical provider.
