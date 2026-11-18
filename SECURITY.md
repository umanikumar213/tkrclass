# Security configuration

The existing pages, moderation flow, Railway start command (`node server.js`), and database records are preserved. Startup setup adds missing tables/columns/indexes; it does not reset reactions or rewrite/delete posts. The text-column alteration is tracked once in `schema_migrations`, in a transaction with a cross-process advisory lock. Previously removed Reyi data-fix `UPDATE`/`DELETE` statements remain removed rather than being reintroduced.

## Environment

- Keep `ADMIN_PASSWORD` and `SESSION_SECRET` configured as secrets. The latter signs the HttpOnly visitor identity used by both feeds. If it is missing, reaction writes fail explicitly rather than falling back to untracked counts.
- `ALLOWED_ORIGINS`: optional comma-separated additional browser origins, for example `https://mytkr.in,https://www.mytkr.in`. Same-origin requests and clients without an Origin header always work; unlisted cross-origin requests receive 403.
- `DB_SSL_VERIFY=true`: opt into database certificate verification. The default remains `rejectUnauthorized:false` for compatibility with the existing Railway connection. A localhost database continues to use plain local connections. Do not enable verification until the database's certificate chain is trusted.
- Telegram credentials remain unchanged. New video submissions save the Telegram message ID. Admin deletion removes the database row first and then attempts Telegram deletion, with a timeout. Telegram may refuse older messages or messages the bot cannot delete. Existing videos without a stored message ID cannot be retroactively deleted automatically; a warning is logged.

The CSP intentionally allows inline scripts and event handlers used by the existing HTML. It denies framing (`frame-ancestors 'none'` and `X-Frame-Options: DENY`), including embedding inside third-party preview iframes. Open the app directly when inspecting it in a framed environment.

Rate limits and admin lockouts are in memory per Node process. They reset on restart and are not synchronized across multiple Railway replicas. Visitor reactions are persisted transactionally in PostgreSQL and remain correct across processes.

The `qs` override keeps Express's query parser on a patched compatible release; do not remove it without rechecking the audit.

## Verification

```sh
node scripts/test-security.js
node scripts/test-chat-admin-posts.js
npm audit
node server.js
```

Tests use disposable PostgreSQL schemas and simulated Telegram/college transports. They never contact the college portal or delete real Telegram messages. They need access to a development database whose user can create/drop schemas; do not run tests with a production connection.
