# Threat Model

## Project Overview

TKRClass is a Node.js 20 / Express application providing attendance lookup, an anonymous confession board, a separate night-only Reyi feed, and password-protected moderation. PostgreSQL stores content and reactions; Telegram stores video files. Route/file inventories and deployment configuration are in `replit.md`. This document describes the current controls and residual risks, not a security certification.

## Assets

- **Secrets and privileged access:** `ADMIN_PASSWORD`, `SESSION_SECRET`, the database connection string, and Telegram credentials. Their compromise permits moderation abuse, identity/session forgery, data access, or video-storage abuse.
- **Submitted content:** pending and approved posts, images, videos, and comments may contain sensitive personal disclosures. Moderation state and restricted media access must remain authoritative.
- **Attendance data:** roll numbers, names, attendance and subject/day details cross the college boundary and enter a short-lived server cache; they are not persisted in PostgreSQL.
- **Integrity and availability:** post numbering, reaction ownership/counters, moderation decisions, and the ability to reach the college portal, PostgreSQL, and Telegram.

## Trust Boundaries

- **Browser ↔ Express:** all IDs, bodies, uploads, cookies, and reaction choices are untrusted. The server serves static files only from `public/`, not the repository root. Header authentication protects moderation; Reyi also accepts its signed admin cookie.
- **Proxy ↔ Express:** `trust proxy` is set to one hop. IP-based protections and secure-cookie detection depend on the actual hosting proxy preventing client spoofing of the trusted forwarding position. Public traffic requires HTTPS termination at the host.
- **Express ↔ college portal:** roll numbers are validated; form actions and redirects are constrained to the fixed portal host/path. The upstream portal uses unencrypted HTTP, so network interception remains possible. The browser separately requests profile photos over HTTPS from `tkrcet.in`.
- **Express ↔ PostgreSQL:** parameterized values and a shared pool protect normal database operations. Hosted TLS certificate verification is disabled by default for compatibility; `DB_SSL_VERIFY=true` opts into verification with an appropriate trust chain.
- **Express ↔ Telegram:** bot-token HTTPS requests upload, resolve, stream, and attempt deletion of video messages. Videos leave the application/database trust boundary and depend on the channel's access controls and Telegram's policies.
- **Public ↔ moderation/night window:** pending content and admin publishing require server authorization. Public Reyi content operations are gated by the IST opening window; administrators can review outside it. The window is not a retention policy or a guarantee against recording previously viewed content.

## Scan Anchors

- Follow request paths from `server.js` into `chat.js` and `reyi.js`; inspect upload/stream handlers and all moderation mutations.
- Review `lib/admin.js`, `security.js`, `reactions.js`, and `lib/media.js` for authentication, cookie validation, counter integrity, and file-processing boundaries.
- Review `lib/telegram.js`, `db.js`, `lib/migrations.js`, `lib/attendance.js`, and `attendance-security.js` for external-service and migration risks.
- `public/*-admin.html` contains browser-side credential handling. Regression scripts under `scripts/` use disposable schemas and simulated external transports; they are not HTTP routes and must not run against production.

## Threat Categories

### Spoofing and elevation of privilege

Admin passwords use one shared timing-safe comparison. All password-bearing admin/media routes share a per-IP five-failure, 15-minute lockout; successful authentication clears failures. Anonymous media requests do not count as password failures. Both admin pages retain entered passwords only in JavaScript memory, not `sessionStorage` or `localStorage`; Reyi also issues a signed, 30-minute HttpOnly SameSite=Strict admin cookie. `SESSION_SECRET` actively signs that cookie and the shared visitor identity.

Every privileged operation MUST enforce authorization server-side, independent of UI controls or multipart fields. A shared password provides no individual-admin attribution or MFA. Distributed attackers, process restarts, and multiple replicas weaken in-memory per-IP lockouts. Strong secrets, correct proxy configuration, and protected admin browsers remain essential.

### Tampering

Signed HttpOnly visitor cookies identify reaction ownership. Transactions lock the parent post, read the stored prior reaction, change one visitor/post record, and adjust counters without trusting client `prev` values. Counters must never become negative. This limits one reaction per cookie identity, not per real person: visitors can obtain another identity by clearing cookies.

SQL values MUST remain parameterized; dynamic table/emoji identifiers must come only from server-owned allow-lists. Ordinary submissions cannot grant themselves approval or admin pinning. Images are re-encoded with sharp; MP4 container structure is validated before upload. Container validation is not malware scanning or proof that a video decodes safely in every player.

### Information disclosure and script injection

Only approved posts/comments are public; pending media requires admin access. Media handlers must check authorization and status before consulting Telegram caches. Avatar values are assigned through DOM properties with encoded URL components. Displayed post/comment text must stay escaped.

Helmet supplies CSP and other headers. The policy allows required fonts/images/media and blocks framing, but intentionally permits inline scripts/handlers for the current HTML. An XSS flaw could still expose in-memory admin passwords or issue privileged requests; HttpOnly alone does not stop same-origin script abuse. CORS permits configured origins, same-origin traffic, and clients without Origin; it is not authentication or a defense against non-browser scraping.

Unhandled errors return generic JSON and malformed JSON returns 400. Attendance errors log error type/code rather than roll numbers or credential-bearing Axios objects. Logs and all future error paths MUST avoid secrets, student data, and upstream request objects. Attendance lookup currently accepts a roll number rather than a verified student login, so knowledge of a valid roll number is sufficient to request its attendance.

### Denial of service

Current per-IP limits include attendance login at 5/minute, reactions at 30/minute per board, reports at 10/hour per board, image requests at 120/minute per board, and video requests at 60/minute per board. Post reservations are taken before uploads: one public chat post per three minutes or Reyi submission per ten minutes, with failed submissions released for retry. Comment submission limits also apply.

Image/video size limits, timeouts, temporary-file cleanup, bounded attendance/feed caches, a feed-page ceiling, and expiring Telegram file paths constrain resource use. Reaction responses return current counts without invalidating entire feed caches; moderation invalidates them. These controls do not provide global concurrency or bandwidth quotas. IP rotation, shared NATs, native image processing, public feed/comment reads, and slow streaming remain availability concerns. Limits and caches are process-local and reset on restart.

### Retention, deletion, and repudiation

There is no automatic seven-day post purge. Admin deletion removes the database row and dependent comments/reactions, then attempts Telegram message deletion. Telegram refusal, missing message IDs on older posts, copied content, or third-party backups can leave media outside application control; deletion MUST NOT be represented as guaranteed erasure from all systems.

Named one-time migrations run transactionally with an advisory lock and an applied-migration record. Previously removed Reyi data-repair UPDATE/DELETE statements are not reinstated at startup. Changes to migrations require review because they operate with database privileges. A shared admin credential and the lack of a dedicated per-action audit trail limit attribution of moderation decisions.
