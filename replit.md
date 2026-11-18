# TKRClass

Node.js 20 / Express application for TKR attendance checking, the confession board, and the night-only Reyi feed. The frontends are plain HTML/CSS/JavaScript under `public/`.

## Routes

| Page | Purpose |
| --- | --- |
| `/` | Attendance checker; submits a roll number to `POST /login`. |
| `/chat` | Public confession board, with anonymous text and optional image or MP4 video posts. |
| `/chat/admin` | Confession moderation, comment approval, and admin publishing of highlighted pinned posts. |
| `/reyi` | Separate Reyi video/story feed, open **11 PM–5 AM IST** (Asia/Kolkata). |
| `/reyi/admin` | Reyi moderation; administrators can review outside the public opening window. |

API routes are mounted under `/api/chat/*` and `/api/reyi/*`. Ordinary posts/comments require approval. Admin-authored pinned posts belong only to `/chat`, not the homepage or `/reyi`.

## Files and services

- `server.js` — LF-encoded Express entry point; security headers, CORS allow-list, JSON errors, `/login` attendance scraping, and **only** `public/` static serving. Mounts both routers and initializes their schemas before listening.
- `chat.js` / `reyi.js` — board-specific routes, validation, moderation, counters, and feed caching.
- `db.js` — one shared PostgreSQL pool. Existing Railway SSL defaults are retained; certificate verification is opt-in.
- `lib/admin.js` / `lib/client-ip.js` — shared admin authentication, per-IP password lockouts, Reyi admin sessions, and client-IP handling.
- `lib/media.js` — shared multer setup, image compression, and temporary upload cleanup. `media-validation.js` validates MP4 structure.
- `lib/telegram.js` — Telegram video uploads, shared expiring file-path cache, and best-effort message deletion.
- `lib/feed-cache.js` — five-minute feed caches capped at 200 entries; pages above 200 return empty results.
- `lib/migrations.js` — named one-time migrations in `schema_migrations`, protected by a PostgreSQL transaction/advisory lock.
- `lib/attendance.js` / `attendance-security.js` — attendance summary parsing, fixed portal URL checks, and bounded attendance caching.
- `security.js` / `reactions.js` — signed HttpOnly visitor identities, request/submission limits, and transactional per-visitor reactions.

## Storage and retention

PostgreSQL holds posts, compressed image bytes (`BYTEA`), comments, numbering counters, reactions, and Telegram file/message IDs. Images must be JPG/PNG/WebP and no larger than 5 MB; MP4 videos are limited to 20 MB and stored in the configured Telegram channel, not the database or permanent local files. Temporary files are kept outside `public/` and cleaned up.

Admin removal deletes the database post and dependent records, then attempts to delete its Telegram video message. Telegram failures or missing IDs on older videos do not prevent database deletion. **Posts do not automatically delete after seven days.** The Reyi opening window controls access, not retention.

Attendance data comes from `http://103.171.190.44/TKRCET/` and is cached in memory for 60 seconds, with at most 500 entries; it is not saved to PostgreSQL. Browser profile images use `https://tkrcet.in`.

Reaction responses include authoritative counts for the frontend; reactions do not flush the feed cache. Moderation and approved-comment changes invalidate the appropriate board cache.

## Environment

Set these deployment variables; keep credentials in the hosting platform's secret settings, never in source control:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; needed to initialize the database and start the server. |
| `ADMIN_PASSWORD` | Shared moderation password for both boards. |
| `SESSION_SECRET` | Signs visitor reaction identities and the Reyi admin-session cookie. |
| `TELEGRAM_BOT_TOKEN` | Bot credential for video storage and delivery. |
| `TELEGRAM_CHANNEL_ID` | Channel used for uploaded videos; the bot needs the relevant permissions. |
| `ALLOWED_ORIGINS` | Comma-separated additional allowed browser origins, e.g. `https://mytkr.in,https://www.mytkr.in`. Same-origin/no-Origin requests work without additional entries. |
| `NODE_ENV` | Use `production` for production deployments. |
| `DB_SSL_VERIFY` | Optional: `true` enables database certificate verification. Defaults to `rejectUnauthorized:false` for hosted connections; localhost connections use no TLS. |

`PORT` is supplied by the host when available; otherwise the server defaults to 5000. `ALLOWED_ORIGINS` and `NODE_ENV` are deployment configuration, not credentials. Telegram credentials are necessary for video operations; missing admin/session secrets disable the corresponding protected operations rather than bypassing them.

## Run and verify

```sh
npm ci --omit=dev
npm start
```

The Replit workflow runs `PORT=5000 node server.js`; Railway uses `railway.toml` with the same Node entry point. Existing PostgreSQL records survive application redeploys.

```sh
npm test
node scripts/test-security.js
```

Tests need a development PostgreSQL database whose user can create/drop disposable schemas. They simulate Telegram and college traffic; never run them against a production connection.

## Operational limits

Admin passwords are held only in JavaScript memory by the admin pages, not browser web storage. Reyi additionally uses a signed 30-minute HttpOnly admin cookie. Keep `SESSION_SECRET` stable across restarts to preserve valid identities/sessions.

Rate limits, lockouts, and caches are per process and reset on restart; multiple replicas do not share them. The proxy must match the configured one-hop Express trust boundary. The CSP intentionally permits the existing inline scripts/handlers and denies framing, so use a direct browser tab if an embedded preview is blocked. See `threat_model.md` and `SECURITY.md` for remaining security considerations.
