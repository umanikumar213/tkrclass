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
    app.use(express.static(path.resolve(__dirname, '../public'), {
      etag: true,
      setHeaders(res, filePath) {
        if (/\.(css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
        else if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');
      },
    }));
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
      return { status: response.status, body: data, response,
        cookie: response.headers.get('set-cookie')?.split(';')[0],
        cookies: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
    };
    const device = value => crypto.createHash('sha256').update(value).digest('hex');
    const post = (url, options = {}) => {
      if (url.endsWith('/like')) options = {
        ...options, body: { device_hash: device(options.network || ip(1)), ...options.body },
      };
      return request(url, { method: 'POST', ...options });
    };
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
    const releaseAssets = new Set();
    for (const url of ['/spotlight', '/spotlight/admin', `/spotlight/${first}`]) {
      const html = await request(url);
      assert.equal(html.status, 200);
      assert.equal(html.response.headers.get('cache-control'), 'no-store');
      assert.equal(html.response.headers.get('cdn-cache-control'), 'no-store');
      assert.doesNotMatch(html.body, /(?:src|href)="\/spotlight(?:-ui|-editor)?\.(?:js|css)"/);
      assert.doesNotMatch(html.body, /\/spotlight-assets\//);
      const links = [...html.body.matchAll(/(?:src|href)="(\/spotlight(?:-ui|-editor)?\.(?:css|js)\?v=[a-z0-9]+)"/g)];
      assert.ok(links.length >= 3, 'Every Spotlight page must use version queries for CSS and scripts');
      for (const [, asset] of links) releaseAssets.add(asset);
    }
    assert.equal(releaseAssets.size, 4, 'All four Spotlight assets share this release');
    assert.equal(new Set([...releaseAssets].map(url => new URL(url, base).searchParams.get('v'))).size, 1);
    for (const url of releaseAssets) {
      const asset = await request(url);
      assert.equal(asset.status, 200);
      const filename = new URL(url, base).pathname.slice(1);
      assert.equal(asset.response.headers.get('cache-control'), 'no-cache');
      assert.equal(asset.body, fs.readFileSync(path.join(__dirname, '../public', filename), 'utf8'));
      assert.match(asset.response.headers.get('content-type'), filename.endsWith('.css') ? /text\/css/ : /javascript/);
      assert.equal((await request(url, { headers: {
        'If-None-Match': asset.response.headers.get('etag'), 'Cache-Control': 'max-age=0',
      } })).status, 304);
    }
    assert.equal((await request('/spotlight.html')).response.headers.get('cache-control'), 'no-store');
    console.log('PASS: all Spotlight pages use matching version queries, no-store HTML, revalidated CSS/JS and fast 304 responses.');
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
      assert.equal((await request(`/api/spotlight/leaderboard?tab=${tab}`)).body.students.length, 0);
    }
    // Default random eligibility excludes every first-year test profile.
    assert.equal((await request('/api/spotlight/random')).status, 404);
    const contentBefore = (await request('/api/spotlight/texts')).body;
    assert.equal(contentBefore.settings.like_max_per_ip_per_profile, 1);
    assert.equal(contentBefore.settings.like_device_check, true);
    assert.equal(contentBefore.settings.like_rate_per_hour, 30);
    assert.equal((await request('/api/spotlight/admin/settings', { network: ip(40) })).status, 401);
    assert.equal((await post('/api/spotlight/admin/settings', {
      network: ip(41), body: { changes: { brand_name: 'Not allowed' } },
    })).status, 401);
    const save = changes => post('/api/spotlight/admin/settings', { admin: true, body: { changes } });
    assert.equal((await save({ brand_name: 'Campus <Friends>', random_profile_years: ['1st Year'] })).status, 200);
    assert.equal((await request('/api/spotlight/texts')).body.texts.brand_name, 'Campus <Friends>');
    assert.equal((await save({ does_not_exist: 'No' })).status, 400);
    assert.equal((await save({ brand_name: 'x'.repeat(81) })).status, 400);
    assert.equal((await save({ like_device_check: 'false' })).status, 400);
    assert.equal((await save({ like_rate_per_hour: 0 })).status, 400);
    assert.equal((await save({ leaderboard_size: 1.5 })).status, 400);
    assert.equal((await save({ random_profile_years: '1st Year' })).status, 400);
    assert.equal((await save({ random_profile_years: ['1st Year', '1st Year'] })).status, 400);
    assert.equal((await save({ profile_remove_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await save({ profile_remove_url: '//untrusted.example' })).status, 400);
    assert.equal((await save({ profile_remove_url: 'mailto:admin@example.test' })).status, 200);
    await save({ profile_remove_url: null });
    assert.equal((await save({ brand_name: 'Must not be saved', unknown: 'no' })).status, 400);
    assert.equal((await request('/api/spotlight/texts')).body.texts.brand_name, 'Campus <Friends>');
    const random1 = await request('/api/spotlight/random');
    assert.match(random1.body.roll_number, /^[A-Z0-9]{10}$/);
    const random2 = await request('/api/spotlight/random', { cookie: random1.cookies });
    assert.notEqual(random2.body.roll_number, random1.body.roll_number);
    assert.equal((await db.query('SELECT year FROM spotlight_students WHERE roll_number=$1', [random2.body.roll_number])).rows[0].year, '1st Year');
    // One eligible visible record must not be returned twice in a row.
    await db.query('UPDATE spotlight_students SET year=$2 WHERE roll_number=$1', [second, '4th Year']);
    await save({ random_profile_years: ['4th Year'] });
    const onlyRandom = await request('/api/spotlight/random');
    assert.equal(onlyRandom.body.roll_number, second);
    assert.equal((await request('/api/spotlight/random', { cookie: onlyRandom.cookies })).status, 404);
    await post(`/api/spotlight/admin/students/${second}/hide`, { admin: true });
    assert.equal((await request('/api/spotlight/random')).status, 404);
    await post(`/api/spotlight/admin/students/${second}/unhide`, { admin: true });
    await db.query('UPDATE spotlight_students SET year=$2 WHERE roll_number=$1', [second, '1st Year']);
    await save({ brand_name: null, random_profile_years: null });
    assert.equal((await request('/api/spotlight/texts')).body.texts.brand_name, contentBefore.texts.brand_name);
    assert.equal((await db.query("SELECT 1 FROM spotlight_settings WHERE key='brand_name'")).rowCount, 0);
    const redirect = await request(`/spotlight/${first.toLowerCase()}`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.response.headers.get('location'), `/spotlight/${first}`);
    const html = await request(`/spotlight/${first}`);
    assert.equal(html.status, 200);
    assert.ok(html.body.includes('Student &lt;Unsafe &amp; &quot;Name&quot;&gt; on TKR Spotlight'));
    assert.ok(html.body.includes(`property="og:url" content="https://spotlight.example/spotlight/${first}"`));
    assert.ok(html.body.includes(`property="og:image" content="https://spotlight.example/api/spotlight/og/${first}.jpg"`));
    await save({ brand_name: '<Friends & Campus>', og_title: '{name} on {brand} — hello' });
    const editedMeta = await request(`/spotlight/${first}`);
    assert.ok(editedMeta.body.includes('on &lt;Friends &amp; Campus&gt; — hello'));
    assert.ok(!editedMeta.body.includes('on <Friends & Campus>'));
    await save({ brand_name: null, og_title: null });
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
    // New cookies cannot bypass lifetime IP or hashed-device checks.
    assert.equal((await post(`/api/spotlight/students/${first}/like`, { cookie: visitor })).body.like_count, 1);
    const repeatIp = await post(`/api/spotlight/students/${first}/like`, { body: { device_hash: device('different-device') } });
    assert.equal(repeatIp.status, 409);
    assert.equal(repeatIp.body.liked, true);
    assert.equal(repeatIp.body.like_count, 1);
    assert.equal(repeatIp.body.message, contentBefore.texts.like_already);
    await db.query("UPDATE spotlight_likes SET created_at=NOW()-INTERVAL '30 days' WHERE roll_number=$1", [first]);
    assert.equal((await post(`/api/spotlight/students/${first}/like`)).status, 409);
    const repeatDevice = await post(`/api/spotlight/students/${first}/like`, {
      network: ip(2), body: { device_hash: device(ip(1)) },
    });
    assert.equal(repeatDevice.status, 409);
    assert.equal((await request(`/api/spotlight/students/${first}?device_hash=${device(ip(1))}`, { network: ip(2) })).body.likedByMe, true);
    const storedDevice = (await db.query('SELECT device_hash FROM spotlight_likes WHERE roll_number=$1', [first])).rows[0].device_hash;
    assert.equal(storedDevice, crypto.createHmac('sha256', loader.env.SESSION_SECRET).update(device(ip(1))).digest('hex'));
    assert.notEqual(storedDevice, device(ip(1)));
    assert.equal((await post(`/api/spotlight/students/${first}/like`, { network: ip(2), body: { device_hash: null } })).status, 400);
    // Increasing the IP setting allows multiple devices, but the device check still applies.
    await save({ like_max_per_ip_per_profile: 2 });
    const extra = await post(`/api/spotlight/students/${first}/like`, { body: { device_hash: device('different-device') } });
    assert.equal(extra.status, 200);
    assert.equal((await post(`/api/spotlight/students/${first}/like`, { cookie: extra.cookie })).body.liked, false);
    await save({ like_max_per_ip_per_profile: null });
    // Parallel identities cannot exceed the same-IP per-profile ceiling.
    const parallel = await Promise.all(Array.from({ length: 4 }, () =>
      post(`/api/spotlight/students/${second}/like`, { network: ip(3) })));
    assert.equal(parallel.filter(r => r.status === 200).length, 1);
    assert.equal(parallel.filter(r => r.status === 409).length, 3);
    assert.equal((await db.query('SELECT like_count FROM spotlight_students WHERE roll_number=$1', [second])).rows[0].like_count, 1);
    await save({ like_device_check: false });
    assert.equal((await post(`/api/spotlight/students/${second}/like`, { network: ip(21), body: { device_hash: device(ip(3)) } })).status, 200);
    await save({ like_device_check: null, leaderboard_size: 1 });
    assert.equal((await request('/api/spotlight/leaderboard?tab=liked')).body.students.length, 1);
    for (const tab of ['trending', 'liked', 'noted']) {
      assert.ok((await request(`/api/spotlight/leaderboard?tab=${tab}`)).body.students.every(s => s.score > 0));
    }
    await save({ leaderboard_size: null });
    await save({ like_rate_per_hour: 1 });
    assert.equal((await post(`/api/spotlight/students/${noPhoto}/like`, { network: ip(22) })).status, 200);
    assert.equal((await post(`/api/spotlight/students/${noPhoto}/like`, { network: ip(22) })).status, 429);
    await save({ like_rate_per_hour: null });

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
    profile = (await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body;
    assert.equal(profile.notes.length, 1, 'Reporting must not hide an approved note');
    assert.equal(profile.student.note_count, 1);
    assert.equal('reported' in profile.notes[0], false);
    assert.equal('report_count' in profile.notes[0], false);
    assert.equal((await post(`/api/spotlight/notes/${id}/report`, { cookie: visitor })).status, 200);
    let reported = (await request('/api/spotlight/admin/queue', { admin: true })).body.reported;
    assert.equal(reported[0].id, id);
    assert.equal(reported[0].report_count, 1, 'Repeated reports by one voter must be ignored');
    const anotherId = (await db.query(
      `INSERT INTO spotlight_notes(roll_number,text,ip_hash,status,approved_at,created_at)
       VALUES($1,'Another reported note','fixture','approved',NOW(),NOW()+INTERVAL '1 day') RETURNING id`, [first])).rows[0].id;
    await db.query('UPDATE spotlight_students SET note_count=note_count+1 WHERE roll_number=$1', [first]);
    assert.equal((await post(`/api/spotlight/notes/${anotherId}/report`, { cookie: visitor })).status, 200);
    const secondReporter = (await request('/api/spotlight/config', { network: ip(7) })).cookie;
    const simultaneous = await Promise.all(Array.from({ length: 3 }, () =>
      post(`/api/spotlight/notes/${id}/report`, { cookie: secondReporter, network: ip(7) })));
    assert.ok(simultaneous.every(response => response.status === 200));
    reported = (await request('/api/spotlight/admin/queue', { admin: true })).body.reported;
    assert.deepEqual(reported.map(note => note.id), [id, anotherId], 'Reported queue sorts by newest report, not note creation');
    assert.equal(reported[0].report_count, 2, 'Concurrent reports from one voter count once');
    assert.ok(reported[0].last_reported_at);
    assert.equal((await post(`/api/spotlight/notes/${id}/react`, { cookie: visitor, body: { emoji: 'heart' } })).status, 200);
    assert.equal((await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body.notes.find(note => note.id === id).myReaction, 'heart');
    await post(`/api/spotlight/admin/notes/${anotherId}/delete`, { admin: true });
    await post(`/api/spotlight/admin/notes/${id}/keep`, { admin: true });
    profile = (await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body;
    assert.equal(profile.notes.length, 1);
    assert.equal(profile.student.note_count, 1);
    assert.equal((await request('/api/spotlight/admin/queue', { admin: true })).body.reported.length, 0);
    await post(`/api/spotlight/notes/${id}/report`, { cookie: visitor });
    assert.equal((await request('/api/spotlight/admin/queue', { admin: true })).body.reported.length, 0, 'An old reporter cannot reflag a note after Keep');
    assert.deepEqual((await db.query('SELECT reported,report_count FROM spotlight_notes WHERE id=$1', [id])).rows[0], { reported: false, report_count: 2 });
    const thirdReporter = (await request('/api/spotlight/config', { network: ip(8) })).cookie;
    await post(`/api/spotlight/notes/${id}/report`, { cookie: thirdReporter, network: ip(8) });
    assert.equal((await request('/api/spotlight/admin/queue', { admin: true })).body.reported[0].report_count, 3);
    await post(`/api/spotlight/admin/notes/${id}/delete`, { admin: true });
    profile = (await request(`/api/spotlight/students/${first}`, { cookie: visitor })).body;
    assert.equal(profile.notes.length, 0);
    assert.equal(profile.student.note_count, 0);
    assert.equal((await db.query('SELECT 1 FROM spotlight_note_reactions WHERE note_id=$1', [id])).rowCount, 0);
    assert.equal((await db.query('SELECT 1 FROM spotlight_note_reports WHERE note_id=$1', [id])).rowCount, 0);
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
    const generic = Buffer.from(await (await fetch(`${base}/api/spotlight/og/26K91A9999.jpg`)).arrayBuffer());
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
    const verifiedLike = await post(`/api/spotlight/students/${second}/like`, { network: ip(15), body: { turnstileToken: 'valid' } });
    assert.equal(verifiedLike.status, 200);
    assert.match(verifiedLike.cookies, /spotlight_verified=/);
    assert.equal(verifyCalls, 2);
    assert.equal((await request('/api/spotlight/config', { cookie: verifiedLike.cookies })).body.turnstileVerified, true);
    assert.equal((await post(`/api/spotlight/students/${second}/like`, { network: ip(15), cookie: verifiedLike.cookies })).status, 200);
    assert.equal(verifyCalls, 2, 'Remembered verification must avoid repeated verification calls');
    const verificationCookie = verifiedLike.cookies.split('; ').find(c => c.startsWith('spotlight_verified='));
    assert.equal((await request('/api/spotlight/config', { cookie: verificationCookie })).body.turnstileVerified, false);
    assert.equal((await request('/api/spotlight/config', { cookie: `${verifiedLike.cookies}x` })).body.turnstileVerified, false);
    delete loader.env.TURNSTILE_SITE_KEY; delete loader.env.TURNSTILE_SECRET;
    await require('./test-spotlight-avatars').runAvatarChecks({ first, noPhoto, db, loader, request, post, directory });
    if (process.argv.includes('--browser')) {
      await require('./test-spotlight-browser').runBrowserChecks({ base, first, noPhoto, db, loader });
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
    assert.equal(imported.like_count, 1);
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
