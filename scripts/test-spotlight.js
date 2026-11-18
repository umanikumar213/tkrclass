// Real PostgreSQL in a disposable schema; never imports or modifies real student records.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const sharp = require('sharp');
const XLSX = require('xlsx');
const { createTestLoader } = require('./security-test-loader');

async function main() {
  const schema = `spotlight_test_${process.pid}_${Date.now()}`;
  const options = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
  };
  const setup = new Pool(options);
  const db = new Pool({ ...options, options: `-c search_path=${schema}` });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spotlight-test-'));
  const timers = [];
  let server, photoReads = 0, verifyResult = true, verifyCalls = 0;
  const originalQuery = db.query.bind(db);
  db.query = (...args) => {
    if (String(args[0]).includes('SELECT photo_data')) photoReads++;
    return originalQuery(...args);
  };
  try {
    await setup.query(`CREATE SCHEMA "${schema}"`);
    const loader = createTestLoader({
      pool: db, directory, timers,
      axios: { async post(url) {
        assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
        verifyCalls++;
        return { data: { success: verifyResult } };
      } },
    });
    loader.env.PUBLIC_URL = 'https://spotlight.example';
    const router = loader.load('spotlight.js');
    await router.initSpotlightDb();
    await router.initSpotlightDb();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json(), router);
    app.use(express.static(path.resolve(__dirname, '../public')));
    app.use((error, req, res, next) => {
      console.error(error);
      res.status(500).json({ message: 'Test server error' });
    });
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ip = n => `198.51.100.${n}`;
    const request = async (url, { method = 'GET', body, cookie, network = ip(1), admin = false, headers = {}, redirect } = {}) => {
      const response = await fetch(base + url, {
        method, redirect,
        headers: { 'x-forwarded-for': network, ...(cookie ? { cookie } : {}),
          ...(admin ? { 'x-admin-password': loader.env.ADMIN_PASSWORD } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, body: data, response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const post = (url, options = {}) => request(url, { method: 'POST', ...options });
    const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#5b45d9' } }).webp().toBuffer();
    const first = '26K91A0101', second = '26K91A0102', noPhoto = '26K91A0103';
    for (let i = 1; i <= 35; i++) {
      const roll = `26K91A01${String(i).padStart(2, '0')}`;
      await db.query(
        `INSERT INTO spotlight_students(roll_number,name,course,section,year,photo_data)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [roll, i === 1 ? 'Student <Unsafe & "Name">' : `Student ${String(i).padStart(2, '0')}`,
          i === 1 ? 'CIVIL' : 'CSE', i === 1 ? null : 'A', '1st Year', i <= 2 ? photo : null]);
    }
    const all = await request('/api/spotlight/students');
    assert.equal(all.status, 200);
    assert.equal(all.body.students.length, 30);
    assert.equal(all.body.hasMore, true);
    const page2 = await request('/api/spotlight/students?page=2');
    assert.equal(page2.body.students.length, 5);
    assert.equal(page2.body.hasMore, false);
    assert.equal(new Set([...all.body.students, ...page2.body.students].map(s => s.roll_number)).size, 35);
    assert.equal((await request('/api/spotlight/students?page=201')).body.students.length, 0);
    assert.equal((await request('/api/spotlight/students?course=civil')).body.students.length, 1);
    assert.equal((await request(`/api/spotlight/students?q=${first.toLowerCase()}`)).body.students[0].roll_number, first);
    const filters = (await request('/api/spotlight/filters')).body;
    assert.deepEqual(filters.years, ['1st Year']);
    assert.ok(!filters.sections.some(row => row.course === 'CIVIL'));
    assert.ok(filters.courses.some(row => row.course === 'CIVIL'));
    for (const tab of ['trending', 'liked', 'noted']) {
      assert.equal((await request(`/api/spotlight/leaderboard?tab=${tab}`)).body.students.length, 20);
    }
    assert.match((await request('/api/spotlight/random')).body.roll_number, /^[A-Z0-9]{10}$/);
    const redirect = await request(`/spotlight/${first.toLowerCase()}`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.response.headers.get('location'), `/spotlight/${first}`);
    const html = await request(`/spotlight/${first}`);
    assert.equal(html.status, 200);
    assert.ok(html.body.includes('Student &lt;Unsafe &amp; &quot;Name&quot;&gt; on TKR Spotlight'));
    assert.ok(html.body.includes(`property="og:url" content="https://spotlight.example/spotlight/${first}"`));
    assert.ok(html.body.includes(`property="og:image" content="https://spotlight.example/api/spotlight/og/${first}.jpg"`));
    delete loader.env.PUBLIC_URL;
    assert.ok((await request(`/spotlight/${first}`)).body.includes(`content="${base}/spotlight/${first}"`));
    loader.env.PUBLIC_URL = 'https://spotlight.example';
    const firstLoad = await request(`/api/spotlight/students/${first.toLowerCase()}`);
    const visitor = firstLoad.cookie;
    assert.ok(visitor?.startsWith('reyi_visitor='));
    assert.match(firstLoad.response.headers.get('set-cookie'), /HttpOnly/);
    assert.equal(firstLoad.body.likedByMe, false);
    assert.equal(firstLoad.response.headers.get('cache-control'), 'no-store');
    let result = await post(`/api/spotlight/students/${first}/like`, { cookie: visitor });
    assert.deepEqual(result.body, { liked: true, like_count: 1 });
    assert.equal((await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body.likedByMe, true);
    assert.equal((await request(`/api/spotlight/students/${first}`, { network: ip(2) })).body.likedByMe, false);
    result = await post(`/api/spotlight/students/${first}/like`, { cookie: visitor });
    assert.deepEqual(result.body, { liked: false, like_count: 0 });
    // Three distinct signed identities on the same network; the fourth is rejected.
    assert.equal((await post(`/api/spotlight/students/${first}/like`, { cookie: visitor })).body.like_count, 1);
    assert.equal((await post(`/api/spotlight/students/${first}/like`)).body.like_count, 2);
    assert.equal((await post(`/api/spotlight/students/${first}/like`)).body.like_count, 3);
    assert.equal((await post(`/api/spotlight/students/${first}/like`)).status, 429);
    // Parallel identities cannot exceed the same-IP per-profile ceiling.
    const parallel = await Promise.all(Array.from({ length: 4 }, () =>
      post(`/api/spotlight/students/${second}/like`, { network: ip(3) })));
    assert.equal(parallel.filter(r => r.status === 200).length, 3);
    assert.equal(parallel.filter(r => r.status === 429).length, 1);
    assert.equal((await db.query('SELECT like_count FROM spotlight_students WHERE roll_number=$1', [second])).rows[0].like_count, 3);

    const noteText = '<script>kind words only</script>';
    assert.equal((await post(`/api/spotlight/students/${first}/notes`, { body: { text: noteText }, cookie: visitor, network: ip(4) })).status, 200);
    assert.equal((await post(`/api/spotlight/students/${first}/notes`, { body: { text: 'Too soon' }, network: ip(4) })).status, 429);
    assert.equal((await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body.notes.length, 0);
    const pending = (await request('/api/spotlight/admin/queue', { admin: true })).body.pending;
    assert.equal(pending.length, 1);
    const id = pending[0].id;
    assert.equal(pending[0].name, 'Student <Unsafe & "Name">');
    assert.equal((await post(`/api/spotlight/admin/notes/${id}/approve`, { admin: true })).status, 200);
    assert.equal((await post(`/api/spotlight/admin/notes/${id}/approve`, { admin: true })).status, 200);
    let profile = (await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body;
    assert.equal(profile.student.note_count, 1);
    assert.equal(profile.notes[0].text, noteText);
    assert.equal(profile.notes[0].myReaction, null);
    result = await post(`/api/spotlight/notes/${id}/react`, { cookie: visitor, body: { emoji: 'heart' } });
    assert.deepEqual(result.body, { counts: { heart: 1, laugh: 0, fire: 0 }, myReaction: 'heart' });
    assert.equal((await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body.notes[0].myReaction, 'heart');
    assert.equal((await request(`/api/spotlight/students/${first}`, { network: ip(5) })).body.notes[0].myReaction, null);
    result = await post(`/api/spotlight/notes/${id}/react`, { cookie: visitor, body: { emoji: 'fire' } });
    assert.deepEqual(result.body, { counts: { heart: 0, laugh: 0, fire: 1 }, myReaction: 'fire' });
    result = await post(`/api/spotlight/notes/${id}/react`, { cookie: visitor, body: { emoji: 'fire' } });
    assert.equal(result.body.myReaction, null);
    assert.equal(result.body.counts.fire, 0);
    assert.equal((await post(`/api/spotlight/notes/${id}/react`, { body: { emoji: '__proto__' } })).status, 400);
    assert.equal((await post(`/api/spotlight/notes/${id}/report`, { cookie: visitor })).status, 200);
    assert.equal((await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body.notes.length, 0);
    assert.equal((await request('/api/spotlight/admin/queue', { admin: true })).body.reported[0].id, id);
    await post(`/api/spotlight/admin/notes/${id}/keep`, { admin: true });
    profile = (await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body;
    assert.equal(profile.notes.length, 1);
    assert.equal(profile.student.note_count, 1);
    await post(`/api/spotlight/admin/notes/${id}/delete`, { admin: true });
    profile = (await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body;
    assert.equal(profile.notes.length, 0);
    assert.equal(profile.student.note_count, 0);
    assert.equal((await db.query('SELECT 1 FROM spotlight_note_reactions WHERE note_id=$1', [id])).rowCount, 0);
    const pendingIp = crypto.createHmac('sha256', loader.env.SESSION_SECRET).update(ip(6)).digest('hex');
    for (let i = 0; i < 10; i++) {
      await db.query('INSERT INTO spotlight_notes(roll_number,text,ip_hash) VALUES($1,$2,$3)', [first, `Pending ${i}`, pendingIp]);
    }
    result = await post(`/api/spotlight/students/${first}/notes`, { network: ip(6), body: { text: 'Eleventh pending note' } });
    assert.equal(result.status, 429);
    assert.match(result.body.message, /10 notes/);
    const rejectedId = (await db.query(`SELECT id FROM spotlight_notes WHERE ip_hash=$1 LIMIT 1`, [pendingIp])).rows[0].id;
    assert.equal((await post(`/api/spotlight/admin/notes/${rejectedId}/reject`, { admin: true })).status, 200);
    assert.equal((await db.query('SELECT 1 FROM spotlight_notes WHERE id=$1', [rejectedId])).rowCount, 0);
    // Photos are cached including missing entries; ETag and OG conversion work.
    const image1 = await fetch(`${base}/api/spotlight/photo/${first}`);
    assert.equal(image1.status, 200);
    const imageBytes = Buffer.from(await image1.arrayBuffer());
    assert.equal((await sharp(imageBytes).metadata()).format, 'webp');
    const readAt = photoReads;
    await fetch(`${base}/api/spotlight/photo/${first}`);
    assert.equal(photoReads, readAt);
    assert.equal((await fetch(`${base}/api/spotlight/photo/${first}`, { headers: { 'If-None-Match': image1.headers.get('etag') } })).status, 304);
    const og = await fetch(`${base}/api/spotlight/og/${first}.jpg`);
    const ogBytes = Buffer.from(await og.arrayBuffer());
    const ogMeta = await sharp(ogBytes).metadata();
    assert.equal(ogMeta.width, 400); assert.equal(ogMeta.height, 400); assert.equal(ogMeta.format, 'jpeg');
    assert.equal((await fetch(`${base}/api/spotlight/photo/${noPhoto}`)).status, 404);
    const missingAt = photoReads;
    await fetch(`${base}/api/spotlight/photo/${noPhoto}`);
    assert.equal(photoReads, missingAt);
    const generic = Buffer.from(await (await fetch(`${base}/api/spotlight/og/${noPhoto}.jpg`)).arrayBuffer());
    // Hide after every public cache has been warmed.
    await post(`/api/spotlight/admin/students/${first}/hide`, { admin: true });
    assert.ok(!(await request('/api/spotlight/students?course=civil')).body.students.length);
    assert.equal((await request(`/api/spotlight/students/${first}`, { cookie: visitor })).status, 404);
    assert.equal((await fetch(`${base}/api/spotlight/photo/${first}`, { headers: { 'If-None-Match': image1.headers.get('etag') } })).status, 404);
    const hiddenOg = Buffer.from(await (await fetch(`${base}/api/spotlight/og/${first}.jpg`)).arrayBuffer());
    assert.ok(hiddenOg.equals(generic));
    const hiddenHtml = await request(`/spotlight/${first}`);
    assert.equal(hiddenHtml.status, 404);
    assert.ok(!hiddenHtml.body.includes('Unsafe'));
    for (const tab of ['trending', 'liked', 'noted']) {
      assert.ok(!(await request(`/api/spotlight/leaderboard?tab=${tab}`)).body.students.some(s => s.roll_number === first));
    }
    assert.equal((await post(`/api/spotlight/students/${first}/like`, { network: ip(8) })).status, 404);
    await post(`/api/spotlight/admin/students/${first.toLowerCase()}/unhide`, { admin: true });
    assert.equal((await fetch(`${base}/api/spotlight/photo/${first}`)).status, 200);
    assert.equal((await request(`/api/spotlight/students/${first}`)).status, 200);
    const login = await post('/api/spotlight/admin/login', { admin: true, network: ip(9) });
    assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await request('/api/spotlight/admin/queue', { cookie: login.cookie, network: ip(9) })).status, 200);
    assert.equal((await request('/api/spotlight/admin/students', { network: ip(10) })).status, 401);
    assert.equal((await request('/api/spotlight/admin/queue', { network: ip(11) })).status, 401);
    assert.equal((await post(`/api/spotlight/admin/notes/${id}/approve`, { network: ip(12) })).status, 401);
    assert.equal((await post(`/api/spotlight/admin/students/${first}/hide`, { network: ip(13) })).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await post('/api/spotlight/admin/login', {
      network: ip(14), headers: { 'x-admin-password': 'incorrect' },
    })).status, 401);
    assert.equal((await post('/api/spotlight/admin/login', { admin: true, network: ip(14) })).status, 429);
    assert.equal((await request('/api/spotlight/students/bad!')).status, 400);
    assert.equal((await post('/api/spotlight/notes/-1/react', { body: { emoji: 'heart' } })).status, 400);
    for (const url of ['/api/spotlight/students', '/api/spotlight/leaderboard', `/api/spotlight/students/${first}`]) {
      const json = JSON.stringify((await request(url)).body);
      for (const field of ['photo_data', 'ip_hash', 'voter_hash']) assert.ok(!json.includes(`"${field}"`));
    }
    loader.env.TURNSTILE_SITE_KEY = 'test-site-key';
    loader.env.TURNSTILE_SECRET = 'test-secret';
    assert.equal((await request('/api/spotlight/config')).body.turnstileSiteKey, 'test-site-key');
    assert.equal((await post(`/api/spotlight/students/${second}/like`, { network: ip(15), body: {} })).status, 400);
    verifyResult = false;
    assert.equal((await post(`/api/spotlight/students/${second}/like`, { network: ip(15), body: { turnstileToken: 'invalid' } })).status, 400);
    verifyResult = true;
    assert.equal((await post(`/api/spotlight/students/${second}/like`, { network: ip(15), body: { turnstileToken: 'valid' } })).status, 200);
    assert.equal(verifyCalls, 2);
    delete loader.env.TURNSTILE_SITE_KEY; delete loader.env.TURNSTILE_SECRET;
    if (process.argv.includes('--browser')) {
      await require('./test-spotlight-browser').runBrowserChecks({ base, first, db, loader });
    }

    // Private import: normalization, null section, resized photos, safe upsert, no data reset.
    const input = path.join(directory, 'students.xlsx'), photosDir = path.join(directory, 'photos');
    fs.mkdirSync(photosDir);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { name: ' Imported Person ', roll_number: ' 26k91a0101 ', course: ' civil ', section: ' ', year: ' 1st Year ' },
      { name: ' No Photo ', roll_number: '26K91A0199', course: 'cse', section: 'A', year: '1st Year' },
    ]), 'Students');
    XLSX.writeFile(workbook, input);
    fs.writeFileSync(path.join(photosDir, `${first}.webp`), photo);
    fs.writeFileSync(path.join(photosDir, '26K91A0198.webp'), photo);
    const importer = loader.load('scripts/import-students.js');
    const summary = await importer.importStudents({ file: input, photosDir, log() {} });
    assert.equal(summary.imported, 2);
    assert.equal(summary.photosMatched, 1);
    assert.equal(summary.studentsWithoutPhoto, 1);
    assert.equal(summary.photosWithoutStudent[0], '26K91A0198');
    const imported = (await db.query('SELECT * FROM spotlight_students WHERE roll_number=$1', [first])).rows[0];
    assert.equal(imported.name, 'Imported Person'); assert.equal(imported.course, 'CIVIL'); assert.equal(imported.section, null);
    assert.equal(imported.like_count, 3);
    assert.equal((await sharp(imported.photo_data).metadata()).width, 200);
    assert.equal((await sharp(imported.photo_data).metadata()).height, 200);
    await importer.importStudents({ file: input, photosDir, log() {} });
    assert.equal((await db.query('SELECT 1 FROM spotlight_students WHERE roll_number=$1', [first])).rowCount, 1);
    const { SpotlightCache } = loader.load('lib/spotlight-cache.js');
    const lru = new SpotlightCache({ max: 2, bytes: 6 });
    lru.set('one', Buffer.alloc(3)); lru.set('two', Buffer.alloc(3)); lru.get('one');
    lru.set('three', Buffer.alloc(3));
    assert.equal(lru.get('two'), undefined); assert.equal(lru.bytes, 6);
    lru.set('none', null); assert.equal(lru.get('none'), null);
    console.log('PASS: Spotlight import, filtering, pagination, signed identities, transactional likes, moderation, notes, reactions, privacy, media caches, OG, admin lockout, and optional Turnstile.');
  } finally {
    for (const timer of timers) clearInterval(timer);
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await db.end();
    await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await setup.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
