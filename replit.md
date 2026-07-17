# Attendance Saviour + Confession Board

## Overview
Node.js/Express app for TKR College students:
- `/` — attendance checker: scrapes the TKR portal (student enters roll number) and shows attendance %, bunk calculator, subject breakdown.
- `/chat` — anonymous confession board: text + optional image posts, admin-approved, identified only by sequential post numbers (#1, #2, …).
- `/chat/admin` — admin review queue (password login via `ADMIN_PASSWORD` secret).

## How to run
Workflow "Start application" runs `PORT=5000 node server.js`.

## Architecture
- `server.js` — Express server; attendance scraping (`POST /login`), serves static files, mounts `chat.js`. Note: file uses CRLF line endings.
- `chat.js` — confession board router (pages + `/api/chat/*` endpoints).
- `index.html` — attendance frontend. `chat.html` / `chat-admin.html` — confession board frontends.
- PostgreSQL (Replit built-in, `DATABASE_URL`) stores confessions; **images stored as bytea in the DB** so nothing is lost on redeploy (user requirement: data must survive redeploys).
  - Tables: `confessions`, `confession_counter` (gapless approved-post numbering).
- Image uploads re-encoded with sharp (strips EXIF/GPS metadata), max 5MB, jpg/png/webp only.
- Rate limit: 1 post per 3 min per IP (in-memory; `trust proxy` set so `req.ip` is the real client IP).
- Posts auto-delete 7 days after their own created_at (purged on feed/queue loads).

## Secrets
- `ADMIN_PASSWORD` — confession board admin login.
- `SESSION_SECRET` — present, currently unused.

## User preferences
- Data must persist across redeploys → use PostgreSQL, not filesystem/SQLite.
