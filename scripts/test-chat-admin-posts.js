// Integration regression test using an isolated PostgreSQL schema and fake Telegram transport.
// Run: node scripts/test-chat-admin-posts.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const { Pool } = require('pg');
const express = require('express');
const sharp = require('sharp');

async function main() {
  const schema = `chat_test_${process.pid}_${Date.now()}`;
  const dbOptions = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false } : false,
  };
  const setup = new Pool(dbOptions);
  const pools = [];
  const timers = [];
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-admin-test-'));
  let server;
  let telegramUploads = 0;
  const sourcePath = path.resolve(__dirname, '../chat.js');
  const realRequire = createRequire(sourcePath);
  const moduleStub = { exports: {} };
  const admin = { 'x-admin-password': 'test-only-admin-password' };
  // Minimal ISO-BMFF fixture for the application's container validator, not a playable movie.
  const box = (name, content) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + content.length);
    header.write(name, 4);
    return Buffer.concat([header, content]);
  };
  const handler = Buffer.alloc(12);
  handler.write('vide', 8);
  const mp4 = Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isom')),
    box('moov', box('trak', box('mdia', box('hdlr', handler)))),
  ]);
  try {
    await setup.query(`CREATE SCHEMA "${schema}"`);
    class TestPool extends Pool {
      constructor() {
        super({ ...dbOptions, options: `-c search_path=${schema}` });
        pools.push(this);
      }
    }
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
      require(name) {
        if (name === 'pg') return { Pool: TestPool };
        if (name === 'os') return { tmpdir: () => testDir };
        if (name === 'axios') return {
          async post(url, form) {
            assert.ok(url.endsWith('/sendVideo'));
            // Consume the multipart stream so the local file descriptor is closed normally.
            await new Promise((resolve, reject) => {
              form.on('end', resolve).on('error', reject).on('data', () => {});
              form.resume();
            });
            telegramUploads++;
            return { data: { ok: true, result: { video: { file_id: `test-video-${telegramUploads}` } } } };
          },
          async get(url) {
            if (url.endsWith('/getFile')) return { data: { ok: true, result: { file_path: 'test.mp4' } } };
            return { status: 200, headers: { 'content-length': mp4.length }, data: Readable.from(mp4) };
          },
        };
        return realRequire(name);
      },
      module: moduleStub,
      __dirname: path.dirname(sourcePath),
      // Never use the real admin password or Telegram credentials in tests.
      process: { env: { ADMIN_PASSWORD: admin['x-admin-password'], TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHANNEL_ID: 'test-channel' } },
      Buffer, console,
      setInterval(fn, delay) {
        const timer = setInterval(fn, delay);
        timers.push(timer);
        return timer;
      },
    }, { filename: sourcePath });
    const router = moduleStub.exports;
    await router.initDb();
    await router.initDb(); // additive migration is safe to repeat
    const db = pools[0];
    const app = express();
    app.use(express.json(), router);
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (url, options) => {
      const r = await fetch(base + url, options);
      return { status: r.status, body: await r.json() };
    };
    const form = (text = 'Admin notice', extras = {}) => {
      const data = new FormData();
      data.append('text', text);
      data.append('mood', 'Other / Casual');
      for (const [key, value] of Object.entries(extras)) data.append(key, value);
      return data;
    };
    const publish = body => request('/api/chat/admin/posts', { method: 'POST', headers: admin, body });
    const feed = async (mood = '', page = 1) =>
      (await request(`/api/chat/posts?page=${page}&mood=${encodeURIComponent(mood)}`)).body.posts;
    assert.equal((await request('/api/chat/admin/posts', { method: 'POST', body: form() })).status, 401);
    assert.equal((await publish(form(''))).status, 400);
    assert.equal((await publish(form('x'.repeat(2501)))).status, 400);
    const invalidMood = form(); invalidMood.set('mood', 'not-a-mood');
    assert.equal((await publish(invalidMood)).status, 400);
    assert.deepEqual(await feed(), []); // prime the empty cache before publishing
    const created = await publish(form('Pinned <script>content</script>'));
    assert.equal(created.status, 200);
    const firstId = created.body.id;
    const post = (await feed())[0];
    assert.equal(post.id, firstId);
    assert.equal(post.is_pinned, true);
    assert.equal(post.is_admin_post, true);
    assert.equal(post.post_number, 1);
    assert.equal((await feed('Heartache'))[0].id, firstId);
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#8844cc' } }).png().toBuffer();
    const both = form();
    both.append('image', new Blob([image], { type: 'image/png' }), 'image.png');
    both.append('video', new Blob([mp4], { type: 'video/mp4' }), 'video.mp4');
    assert.equal((await publish(both)).status, 400);
    const tooLarge = form();
    tooLarge.append('image', new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'big.png');
    assert.equal((await publish(tooLarge)).status, 400);
    const invalidVideo = form();
    invalidVideo.append('video', new Blob(['fake mp4'], { type: 'video/mp4' }), 'fake.mp4');
    assert.equal((await publish(invalidVideo)).status, 400);
    assert.equal(telegramUploads, 0);
    const imageForm = form('Image notice');
    imageForm.append('image', new Blob([image], { type: 'image/png' }), 'image.png');
    const imagePost = await publish(imageForm);
    assert.equal(imagePost.status, 200);
    assert.equal((await fetch(`${base}/api/chat/image/${imagePost.body.id}`)).status, 200);
    const videoForm = form('Video notice');
    videoForm.append('video', new Blob([mp4], { type: 'video/mp4' }), 'video.mp4');
    const videoPost = await publish(videoForm);
    assert.equal(videoPost.status, 200);
    assert.equal(telegramUploads, 1);
    assert.equal((await fetch(`${base}/api/chat/stream/test-video-1`)).status, 200);
    // Public fields cannot impersonate an admin or bypass approval.
    const ordinary = await request('/api/chat/posts', {
      method: 'POST', body: form('Normal post', { is_admin_post: 'true', is_pinned: 'true', status: 'approved' }),
    });
    assert.equal(ordinary.status, 200);
    const normal = (await db.query(`SELECT * FROM confessions WHERE text='Normal post'`)).rows[0];
    assert.equal(normal.status, 'pending');
    assert.equal(normal.is_pinned, false);
    assert.equal(normal.is_admin_post, false);
    assert.ok(!(await feed()).some(p => p.id === normal.id));
    assert.equal((await request(`/api/chat/admin/approve/${normal.id}`, { method: 'POST', headers: admin })).status, 200);
    let posts = await feed();
    assert.ok(posts.slice(0, 3).every(p => p.is_pinned));
    assert.equal(posts.at(-1).id, normal.id); // newer regular posts remain below pins
    // Pinning is persisted in PostgreSQL, without an expiry.
    await db.query(`UPDATE confessions SET created_at=NOW()-INTERVAL '90 days' WHERE id=$1`, [firstId]);
    const queue = await request('/api/chat/admin/queue', { headers: admin });
    assert.ok(queue.body.posts.some(p => p.id === firstId && p.is_pinned));
    assert.equal((await request(`/api/chat/posts/${firstId}/react`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: 'heart', prev: null }),
    })).status, 200);
    assert.equal((await feed()).find(p => p.id === firstId).react_heart, 1);
    assert.equal((await request(`/api/chat/posts/${firstId}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Reply to admin' }),
    })).status, 200);
    const comments = await request('/api/chat/admin/comments-queue', { headers: admin });
    assert.equal(comments.body.comments.length, 1);
    assert.equal((await request(`/api/chat/admin/approve-comment/${comments.body.comments[0].id}`,
      { method: 'POST', headers: admin })).status, 200);
    // Exercise pagination with pinned items ahead of the regular feed, without duplicates.
    for (let i = 0; i < 11; i++) await db.query(
      `INSERT INTO confessions(text,status,post_number,mood) VALUES($1,'approved',$2,'Heartache')`, [`Page post ${i}`, 100 + i]);
    const last = await publish(form('Pagination pin')); // also invalidates the cache
    const pages = [...await feed(), ...await feed('', 2)];
    assert.equal(pages[0].id, last.body.id);
    assert.equal(new Set(pages.map(p => p.id)).size, pages.length);
    assert.equal(pages.length, 16);
    // Removing the post clears all mood caches and removes media access.
    assert.equal((await request(`/api/chat/admin/reject/${imagePost.body.id}`, { method: 'POST' })).status, 401);
    for (const id of [firstId, imagePost.body.id, videoPost.body.id, last.body.id]) {
      assert.equal((await request(`/api/chat/admin/reject/${id}`, { method: 'POST', headers: admin })).status, 200);
      assert.ok(!(await feed()).some(p => p.id === id));
      assert.ok(!(await feed('Heartache')).some(p => p.id === id));
    }
    assert.equal((await fetch(`${base}/api/chat/image/${imagePost.body.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/chat/stream/test-video-1`)).status, 404);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM confession_comments')).rows[0].n, 0);
    // Cleanup runs in finally after the response has been sent.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(fs.readdirSync(path.join(testDir, 'chat-uploads')), []);
    console.log('PASS: admin auth, publishing, uploads, validation, persistent pin order, mood filters, pagination, comments, reactions, removal, and public approval.');
  } finally {
    for (const timer of timers) clearInterval(timer);
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    for (const pool of pools) await pool.end();
    await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await setup.end();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });