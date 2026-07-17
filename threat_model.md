# Threat Model

## Project Overview

A Node.js/Express web application for TKR College students with two surfaces:
1. **Attendance checker** (`/`) — students enter a roll number; the server scrapes the TKR college portal and returns attendance data.
2. **Anonymous confession board** (`/chat`) — students submit text + optional image posts; an admin reviews and approves them before they appear publicly. Admin panel at `/chat/admin` is protected by a shared password (`ADMIN_PASSWORD` env var).

Stack: Node.js, Express, PostgreSQL (Replit built-in), sharp for image processing, cheerio/axios for scraping. Not formally deployed (no Replit deployment active). Runs on port 5000.

## Assets

- **Admin password** — single shared secret (`ADMIN_PASSWORD`) granting full control over the confession board (approve, reject, delete posts). Compromise allows mass deletion or abuse of moderation.
- **Confession content** — text and images submitted by students. Anonymous but still potentially sensitive (personal disclosures). Stored in PostgreSQL as `bytea`.
- **Source code and configuration** — `server.js`, `chat.js`, `package.json`, `.replit`. Exposure reveals scraping logic, database schema, API routes, and admin API details.
- **Student data from portal scraping** — roll number, name, attendance percentages, per-subject data. Short-lived in-memory cache (60s). Not persisted to DB.

## Trust Boundaries

- **Browser to API** — all public API requests are untrusted. Admin API requires `x-admin-password` header but has no rate limiting.
- **API to TKR portal** — server makes outbound HTTP requests to `http://103.171.190.44/TKRCET` using student-supplied roll numbers. The target is a fixed hardcoded URL, so no SSRF from user input.
- **API to PostgreSQL** — direct internal connection. SSL verification is disabled (`rejectUnauthorized: false`).
- **Public vs admin surface** — confession feed is public; admin queue/approve/reject require the shared password header.

## Scan Anchors

- **Entry points**: `server.js` (POST /login for scraping, mounts chat router, serves static files), `chat.js` (all `/api/chat/*` and `/chat` page routes)
- **Highest-risk areas**: `app.use(express.static('.'))` in `server.js`; admin auth in `requireAdmin()` in `chat.js`; CORS config
- **Public surface**: GET /api/chat/posts, POST /api/chat/posts, GET /api/chat/image/:id, POST /api/chat/posts/:id/report
- **Admin surface**: POST /api/chat/admin/login, GET /api/chat/admin/queue, POST /api/chat/admin/approve/:id, POST /api/chat/admin/reject/:id, POST /api/chat/admin/unflag/:id
- **Dev-only**: none; entire codebase is production

## Threat Categories

### Information Disclosure

The most critical active issue: `app.use(express.static('.'))` serves the repository root, exposing `server.js`, `chat.js`, `package.json`, `package-lock.json`, `.replit`, and the `scripts/` directory over HTTP. Any user can read the full application source code. Error messages from scraping failures are forwarded verbatim to clients via `err.message`.

### Spoofing / Elevation of Privilege

The admin password (`x-admin-password` header) has no brute-force or rate-limiting protection. An attacker can try passwords indefinitely at high speed. The password is also stored in plaintext in `sessionStorage` in the admin browser client.

### Tampering

CORS is configured with `app.use(cors())` defaults, which sets `Access-Control-Allow-Origin: *` and allows all request headers. This means any origin can read API responses, including the confession feed and image blobs. Combining this with the exposed source code makes it trivial for a third party to build a scraper.

### Denial of Service

No rate limiting on the `/login` scraping endpoint — each request triggers an outbound HTTP session to the slow college portal (up to 30s timeout). A burst of requests from a single IP can exhaust server concurrency. The in-memory post rate limit (1 post/3min/IP) applies only to confession submissions.

### Cryptographic Failures

PostgreSQL SSL is configured with `rejectUnauthorized: false`, disabling certificate verification. If the database host certificate is forged (MITM), the connection proceeds without warning.
