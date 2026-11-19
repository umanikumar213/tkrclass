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
| `/spotlight` | Student discovery, year/course/section filters, search, and configurable campus leaderboards. |
| `/spotlight/:roll` | Student profile, likes, reviewed notes, reactions, reports, and sharing. Lowercase rolls redirect to uppercase. |
| `/spotlight/admin` | Shared-admin review desk for notes, reports, student visibility, and Content & Settings. |

API routes are mounted under `/api/chat/*` and `/api/reyi/*`. Ordinary posts/comments require approval. Admin-authored pinned posts belong only to `/chat`, not the homepage or `/reyi`.

Spotlight is independent and available all day at `/api/spotlight/*`; it does not use the Reyi night window. Its attendance-homepage link remains hidden until the user asks to enable it.

Spotlight's students use it only on phones. Prioritize 360–430px layouts and touch interaction; desktop support is secondary. Keep visual redesigns separate from the backend APIs, stored records, authentication and abuse-prevention rules.

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
- `spotlight.js` — Spotlight pages, server-rendered Open Graph tags, public APIs, and additive startup initialization.
- `lib/spotlight-db.js` — `spotlight_students`, `spotlight_likes`, `spotlight_notes`, `spotlight_note_reactions`, and `spotlight_settings` tables and additive indexes/columns. Startup creates schema only; it never imports students.
- `lib/spotlight-texts.js` / `lib/spotlight-settings.js` — editable copy catalogue, typed settings, validated overrides, and five-minute merged-content cache.
- `lib/spotlight-admin.js` / `lib/spotlight-security.js` — the existing shared admin lockout/session helpers, hashed visitor/IP identities, Spotlight rate limits, and optional Turnstile checks.
- `lib/spotlight-store.js`, `lib/spotlight-cache.js`, `lib/spotlight-media.js` — transactional counters, bounded caches, hidden-profile checks, photo delivery, and JPEG previews.
- `scripts/import-students.js` — manual private Excel/photo import using patched official SheetJS (`xlsx`) and sharp; never run automatically.

## Storage and retention

PostgreSQL holds posts, compressed image bytes (`BYTEA`), comments, numbering counters, reactions, and Telegram file/message IDs. Images must be JPG/PNG/WebP and no larger than 5 MB; MP4 videos are limited to 20 MB and stored in the configured Telegram channel, not the database or permanent local files. Temporary files are kept outside `public/` and cleaned up.

Admin removal deletes the database post and dependent records, then attempts to delete its Telegram video message. Telegram failures or missing IDs on older videos do not prevent database deletion. **Posts do not automatically delete after seven days.** The Reyi opening window controls access, not retention.

Attendance data comes from `http://103.171.190.44/TKRCET/` and is cached in memory for 60 seconds, with at most 500 entries; it is not saved to PostgreSQL. Browser profile images use `https://tkrcet.in`.

Reaction responses include authoritative counts for the frontend; reactions do not flush the feed cache. Moderation and approved-comment changes invalidate the appropriate board cache.

## TKR Spotlight

Students are imported only from college-approved data. Store the workbook and photos in **`data/`**, which is excluded from Git and Replit publishing. Do not put them in `public/`, commit them, or upload exports to the public repository.

1. Create `data/students.xlsx`. The first worksheet must have headers `name`, `roll_number`, `course`, `section`, `year`. For example: `Aniketh Mhetre`, `26K91A0101`, `CIVIL`, blank section, `1st Year`.
2. Place photos at `data/photos/<ROLL_NUMBER>.webp`. Missing photos are allowed.
3. With the intended database configured, run:

   ```sh
   npm run import:students
   # Optional alternate locations:
   node scripts/import-students.js --file data/students.xlsx --photos data/photos
   ```

4. Read the import summary, including unmatched photo roll numbers and missing-photo count. Restart the application after importing so metadata, hidden-roll, and photo caches reload.

All values are trimmed; rolls and courses become uppercase; blank sections become SQL NULL. Photos are re-encoded as 200×200 WebP, cover fit, quality 70, and stored as BYTEA. Validation/photo conversion completes before the write transaction. Upserts preserve existing visibility, likes, notes, and an existing photo when no replacement photo is supplied. Re-running is safe; the script does not delete students absent from the workbook.

The four Spotlight tables hold students/photos, one like per signed visitor/profile, moderated notes, and one reaction per visitor/note. IP values are HMAC-SHA256 hashes using `SESSION_SECRET`, never raw IP columns. There are no student login accounts, ranks, contact numbers, or public bulk-export endpoint. Notes are limited to 200 characters and remain private until individually approved. Reports immediately hide a note; Keep restores it, and Reject/Delete permanently remove it. Hiding a student removes public directory/profile/photo/leaderboard access without deleting the record. The profile removal contact link is intentionally a placeholder until the administrator supplies a destination.

Public APIs:

- `GET /api/spotlight/config`, `/filters`, `/students`, `/students/:roll`, `/random`, `/leaderboard?tab=trending|liked|noted`
- `GET /api/spotlight/photo/:roll`, `/og/:roll.jpg`
- `POST /api/spotlight/students/:roll/like`, `/students/:roll/notes`, `/notes/:id/react`, `/notes/:id/report`

Admin APIs (existing `ADMIN_PASSWORD`, per-IP lockout, and shared signed 30-minute HttpOnly `reyi_admin` cookie):

- `POST /api/spotlight/admin/login`, `/logout`
- `GET /api/spotlight/admin/queue`, `/students?q=`, `/settings`
- `POST /api/spotlight/admin/settings` — atomic changed-only content/settings save; `null` resets an override
- `POST /api/spotlight/admin/notes/:id/approve|reject|keep|delete`
- `POST /api/spotlight/admin/students/:roll/hide|unhide`

Directory pages fetch 31 rows and return 30 plus `hasMore`; pages above 200 are empty. Filters cache for one hour, lists/public profile data for five minutes, and the three leaderboards for ten minutes. Leaderboards show only positive scores, with an editable size (default 20). Trending is new likes plus twice approved notes over the last 24 hours. Visitor-specific `likedByMe` and `myReaction` are merged per request and never shared-cached; profile JSON uses `Cache-Control: no-store`. Moderation clears Spotlight metadata caches; hiding/unhiding also invalidates that student's media. Like/reaction responses are immediately authoritative, while lists/leaderboards may retain their documented TTL.

`lib/spotlight-texts.js` is the single catalogue of editable copy, emojis, OG templates, defaults, groups, limits and setting types. `spotlight_settings` contains only saved overrides. `GET /api/spotlight/texts` merges these with defaults in a five-minute server cache; an admin save clears that cache and Spotlight metadata caches immediately. Browsers fetch the merged copy once per page and insert it as text, never HTML. The protected Content & Settings tab validates changed-only batches and rejects unknown keys, wrong types and oversized values; resetting deletes only the override. Existing student/like/note data is not replaced by these additive schema changes.

Random profiles use `random_profile_years` (default `3rd Year`, `4th Year`), exclude hidden profiles, and exclude the visitor's last pick using a signed HttpOnly cookie bound to the signed visitor identity. If no different eligible profile exists, the API returns 404 rather than repeating the last profile.

Separate photo and OG LRU caches each allow at most 3,000 entries / 25 MiB, including cached missing photos. An in-memory hidden-roll set is loaded at startup and checked before cached media delivery. Photos use ETag, 304 support, and the requested seven-day immutable browser cache. Hidden/missing OG images return a generic 400×400 JPEG, not a student's photo. **Previously downloaded images and browser/CDN immutable copies cannot be recalled by hiding a student**; server-side hiding prevents subsequent uncached requests. Use student photos only with appropriate permission.

Spotlight limits per IP: likes default to 30/hour (editable). Each profile allows one active like per IP over the lifetime of stored likes (editable ceiling, no daily reset), and one per device fingerprint when the editable device check is enabled (default on). The client SHA-256 hashes user agent, screen dimensions, pixel ratio, timezone, language, platform and hardware concurrency; only an HMAC of that hash is stored in the nullable `spotlight_likes.device_hash` column. Existing likes remain intact with null device hashes. A blocked repeat returns 409 and a liked state; only the original signed voter may toggle their like off. Parent-row locking serializes competing likes.

These checks are abuse deterrents, not proof of identity: fingerprints can collide or be spoofed, cookies can be cleared, and shared Wi-Fi/NAT users share an IP. Raising the per-profile IP ceiling is an admin decision when shared networks cause false positives. Fingerprint changes can also affect matching. Do not describe this as guaranteed one-person-one-like.

Other Spotlight limits: notes one per two minutes and at most ten pending per hashed IP; reactions 30/minute; reports 10/hour; photo and OG requests share 300/minute. Counter changes and moderation are transactional. Limits/caches/hidden sets are per process; use one application instance or add shared invalidation/limits before scaling to multiple replicas.

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
| `PUBLIC_URL` | Recommended absolute public origin for Spotlight sharing/OG tags, e.g. `https://mytkr.in`. If absent/invalid, uses the request protocol and host. |
| `TURNSTILE_SITE_KEY` | Optional public Cloudflare Turnstile site key. Enabled only when both Turnstile variables are set. |
| `TURNSTILE_SECRET` | Optional Turnstile verification secret. When enabled, like and note submissions require verification and CSP permits `challenges.cloudflare.com`. Managed widgets execute on demand; successful verification is remembered for 24 hours in a purpose-separated signed HttpOnly cookie bound to the visitor identity. |

`PORT` is supplied by the host when available; otherwise the server defaults to 5000. `ALLOWED_ORIGINS` and `NODE_ENV` are deployment configuration, not credentials. Telegram credentials are necessary for video operations; missing admin/session secrets disable the corresponding protected operations rather than bypassing them.

## Run and verify

```sh
npm ci --omit=dev
npm start
```

The Replit workflow runs `PORT=5000 node server.js`; Railway uses `railway.toml` with the same Node entry point. Existing PostgreSQL records survive application redeploys.

Spotlight HTML is sent with `Cache-Control: no-store` and `CDN-Cache-Control: no-store`. Its CSS and scripts use content-fingerprinted `/spotlight-assets/<release>/<file>` paths, generated together at startup. Keep this automatic versioning when updating the design: the production Cloudflare/browser cache can retain ordinary static URLs for four hours, mixing older styles/scripts with new HTML. Fingerprinted assets may be cached immutably because any asset change generates a different release path. Restart the application after changing Spotlight templates or assets.

```sh
npm test
node scripts/test-security.js
```

Tests need a development PostgreSQL database whose user can create/drop disposable schemas. They simulate Telegram and college traffic; never run them against a production connection.

`npm test` includes both the existing confession/admin regression suite and `scripts/test-spotlight.js`. Spotlight tests use a disposable schema and generated workbook/photos; they do not import the real student workbook. The import dependency is the patched official SheetJS 0.20.3 distribution because the older npm-registry `xlsx` release has known vulnerabilities.

## Operational limits

Admin passwords are held only in JavaScript memory by the admin pages, not browser web storage. Reyi additionally uses a signed 30-minute HttpOnly admin cookie. Keep `SESSION_SECRET` stable across restarts to preserve valid identities/sessions.

Rate limits, lockouts, and caches are per process and reset on restart; multiple replicas do not share them. The proxy must match the configured one-hop Express trust boundary. The CSP intentionally permits the existing inline scripts/handlers and denies framing, so use a direct browser tab if an embedded preview is blocked. See `threat_model.md` and `SECURITY.md` for remaining security considerations.
