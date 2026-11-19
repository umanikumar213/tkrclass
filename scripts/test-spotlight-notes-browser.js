const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { checkPublicNavigation } = require('./test-spotlight-leaderboard-browser');

async function runNotesBrowserChecks({ browser, base, db, loader, noPhoto }) {
  const output = path.resolve(__dirname, '../generated-artifacts/spotlight-notes');
  await fs.mkdir(output, { recursive: true });
  const inserted = await db.query(
    `INSERT INTO spotlight_notes(roll_number,text,ip_hash,status,created_at,approved_at)
     SELECT $1,CASE WHEN n=45 THEN '<b>Not HTML</b>'||chr(10)||'Second line' ELSE 'Browser feed fixture '||n END,
       'private-feed-browser','approved',NOW()-INTERVAL '1 year',NOW()-INTERVAL '1 minute'
     FROM generate_series(1,45) n RETURNING id,text`, [noPhoto]);
  const xss = inserted.rows.find(row => row.text.includes('<b>'));
  const fresh = [];
  const store = loader.load('lib/spotlight-store.js');
  const errors = [];
  store.clearSpotlightCaches();
  try {
    for (const width of [360, 390, 430, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce',
        extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${width === 1440 ? 154 : 150 + [360,390,430].indexOf(width)}` },
      });
      // The 390px case deliberately exercises the manual fallback.
      if (width === 390) await context.addInitScript(() => { delete window.IntersectionObserver; });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(`${base}/spotlight/notes`);
        await page.waitForFunction(() => document.querySelectorAll('.sp-feed-note').length === 20);
        await checkPublicNavigation(page, 'notes');
        const firstCard = page.locator('.sp-feed-note').first();
        assert.equal((await firstCard.locator('.sp-avatar').boundingBox()).width, 40);
        assert.equal(await firstCard.locator('.sp-avatar').evaluate(node => getComputedStyle(node).borderRadius), '50%');
        assert.equal(await firstCard.locator('[data-reaction=heart] span').first().textContent(), '❤️');
        assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme), 'light');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(output, `notes-${width}.png`) });
        if (width === 360) {
          let failed = 0;
          await page.route('**/api/spotlight/notes/feed?*', route => {
            if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue();
            failed++;
            return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Temporary failure"}' });
          });
          await page.locator('#notesFeedSentinel').scrollIntoViewIfNeeded();
          await page.locator('[data-feed-error]').waitFor();
          await page.waitForTimeout(350);
          assert.equal(failed, 1, 'Automatic pagination must not loop after failure');
          assert.equal(await page.locator('.sp-feed-note').count(), 20);
          await page.unroute('**/api/spotlight/notes/feed?*');
          await page.locator('[data-feed-error] button').click();
          await page.waitForFunction(() => document.querySelectorAll('.sp-feed-note').length === 40);
        }
        while (await page.locator('#notesFeedMore').isVisible()) {
          const before = await page.locator('.sp-feed-note').count();
          if (width === 390) await page.locator('#notesFeedMore').click();
          else await page.locator('#notesFeedSentinel').scrollIntoViewIfNeeded();
          await page.waitForFunction(count => document.querySelectorAll('.sp-feed-note').length > count, before);
        }
        await page.locator('[data-feed-end]').waitFor();
        const expected = await db.query(
          `SELECT n.id FROM spotlight_notes n JOIN spotlight_students s USING(roll_number)
           WHERE n.status='approved' AND s.hidden=FALSE AND n.approved_at IS NOT NULL ORDER BY n.approved_at DESC,n.id DESC`);
        assert.deepEqual(await page.locator('.sp-feed-note').evaluateAll(nodes => nodes.map(node => Number(node.dataset.noteId))), expected.rows.map(row => row.id));
        const escaped = page.locator(`[data-note-id="${xss.id}"]`);
        assert.equal(await escaped.locator('.sp-note-text b').count(), 0);
        assert.equal(await escaped.locator('.sp-note-text').textContent(), xss.text);
        assert.equal(await escaped.locator('.sp-note-text').evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap');
        assert.match(await escaped.locator('.sp-feed-student').getAttribute('href'), new RegExp(`/spotlight/${noPhoto}$`));
        await escaped.locator('[data-reaction=heart]').click();
        await escaped.locator('[data-reaction=heart].is-selected').waitFor();
        await page.reload();
        await page.locator(`[data-note-id="${xss.id}"] [data-reaction=heart].is-selected`).waitFor();
        await escaped.locator('[data-reaction=heart]').click();
        await page.waitForFunction(id => !document.querySelector(`[data-note-id="${id}"] [data-reaction=heart]`).classList.contains('is-selected'), xss.id);
        await escaped.locator('[data-report-menu]').click();
        await escaped.locator('[data-report]').click();
        await page.locator('[data-confirm-accept]').click();
        await page.waitForFunction(id => document.querySelector(`[data-note-id="${id}"] [data-report-menu]`)?.disabled, xss.id);
        assert.equal(await escaped.isVisible(), true, 'Reporting must leave the note visible');
        const pending = await db.query(
          `INSERT INTO spotlight_notes(roll_number,text,ip_hash,created_at)
           VALUES($1,'Freshly approved browser note','private-browser-new','2010-01-01') RETURNING id`, [noPhoto]);
        const id = pending.rows[0].id;
        fresh.push(id);
        const oldHead = await page.locator('.sp-feed-note').first().getAttribute('data-note-id');
        const approval = await context.request.post(`${base}/api/spotlight/admin/notes/${id}/approve`, {
          headers: { 'x-admin-password': loader.env.ADMIN_PASSWORD },
        });
        assert.equal(approval.status(), 200);
        await page.evaluate(() => scrollTo(0, 500));
        await page.bringToFront();
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await page.locator('#notesFeedNew').waitFor({ state: 'visible' });
        const pill = await page.locator('#notesFeedNew').boundingBox();
        assert.ok(pill.y >= 0 && pill.y < 180, 'New notes indicator must remain visible while scrolled');
        assert.equal(await page.locator('.sp-feed-note').first().getAttribute('data-note-id'), oldHead, 'New notes must not prepend until requested');
        await page.evaluate(() => scrollTo(0, 0));
        const refreshRequest = page.waitForRequest(request => request.url().includes('/notes/feed?limit=20'));
        await page.locator('#notesFeedNew').click();
        assert.match((await refreshRequest).headers()['cache-control'], /no-cache/);
        await page.waitForFunction(id => document.querySelector('.sp-feed-note')?.dataset.noteId === String(id), id);
        assert.equal(await page.locator('.sp-feed-note').first().locator('time').textContent(), 'Just now', 'Age must use approval, not original creation');
        await context.request.post(`${base}/api/spotlight/admin/notes/${id}/delete`, {
          headers: { 'x-admin-password': loader.env.ADMIN_PASSWORD },
        });
        if (width === 390) {
          let first = true;
          await page.route('**/api/spotlight/notes/feed?limit=20', route => {
            if (!first) return route.continue();
            first = false;
            return route.fulfill({ status: 200, contentType: 'application/json', body: '{"notes":[],"nextCursor":null}' });
          });
          await page.reload();
          await page.locator('#notesFeed .sp-state').waitFor();
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          await page.locator('#notesFeedNew').waitFor({ state: 'visible' });
          await page.locator('#notesFeedNew').click();
          await page.waitForFunction(() => document.querySelectorAll('.sp-feed-note').length === 20);
          await page.unroute('**/api/spotlight/notes/feed?limit=20');
        }
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: Notes layouts at 360/390/430/1440px, cursor loading/retry, escaped text, persistent reactions, reporting, empty-state refresh and new-approval pills.');
  } finally {
    await db.query('DELETE FROM spotlight_notes WHERE id=ANY($1::int[])', [[...inserted.rows.map(row => row.id), ...fresh]]);
    store.clearSpotlightCaches();
  }
}
module.exports = { runNotesBrowserChecks };
