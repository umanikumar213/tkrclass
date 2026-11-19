// Uses only the existing disposable Spotlight test schema and synthetic student fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runLayoutChecks({ browser, base, first, db, loader }) {
  const output = path.resolve(__dirname, '../generated-artifacts/spotlight-layouts');
  await fs.mkdir(output, { recursive: true });
  // Enough positive scores to exercise both the podium and the remaining ranked list.
  for (let i = 4; i <= 8; i++) {
    const roll = `26K91A01${String(i).padStart(2, '0')}`;
    await db.query(
      `INSERT INTO spotlight_likes(roll_number,voter_hash,ip_hash)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [roll, `layout-voter-${i}`, `layout-network-${i}`]);
    await db.query(
      'UPDATE spotlight_students SET like_count=(SELECT COUNT(*) FROM spotlight_likes WHERE roll_number=$1) WHERE roll_number=$1',
      [roll]);
  }
  loader.load('lib/spotlight-store.js').clearSpotlightCaches();
  const errors = [];
  const checkPage = async (page, label) => {
    const metrics = await page.evaluate(() => {
      const root = document.documentElement;
      return {
        width: innerWidth, scrollWidth: root.scrollWidth,
        family: getComputedStyle(document.body).fontFamily,
        text: getComputedStyle(root).getPropertyValue('--text').trim(),
        muted: getComputedStyle(root).getPropertyValue('--muted').trim(),
        surface: getComputedStyle(root).getPropertyValue('--surface').trim(),
        background: getComputedStyle(root).getPropertyValue('--bg').trim(),
        externalScripts: [...document.scripts].map(s => s.src).filter(src => src && new URL(src).origin !== location.origin),
      };
    });
    assert.ok(metrics.scrollWidth <= metrics.width, `${label}: horizontal page overflow (${metrics.scrollWidth}/${metrics.width})`);
    assert.match(metrics.family, /Plus Jakarta Sans/, `${label}: expected requested font`);
    assert.deepEqual(metrics.externalScripts, [], `${label}: no third-party JavaScript`);
    const luminance = value => {
      let hex = value.replace('#', '');
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      const channels = [0, 2, 4].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
        .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    for (const foreground of [metrics.text, metrics.muted]) {
      for (const background of [metrics.background, metrics.surface]) {
        const a = luminance(foreground), b = luminance(background);
        assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${label}: text contrast below AA`);
      }
    }
  };
  const screenshot = (page, name) => page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
  for (const width of [360, 390, 430, 1440]) {
    for (const theme of ['dark', 'light']) {
      const context = await browser.newContext({
        viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce',
        extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${width === 1440 ? 94 : Math.floor(width / 10) + 50}` },
      });
      try {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/spotlight`);
        await page.locator('#studentGrid .sp-student').first().waitFor();
        await page.locator('#leaderboard a').first().waitFor();
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        await checkPage(page, `Discover ${width} ${theme}`);
        assert.equal(await page.locator('#studentGrid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), width < 600 ? 2 : 4);
        // The leaderboard precedes the directory in the actual document, not just visually.
        assert.equal(await page.evaluate(() => Boolean(document.querySelector('#leaderboard').compareDocumentPosition(document.querySelector('#studentGrid')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
        await screenshot(page, `discover-${width}-${theme}`);
        await page.locator('#studentSearch').fill('Missing student');
        await page.waitForTimeout(350);
        await page.locator('#studentGrid .sp-state').waitFor();
        await page.locator('#clearStudentSearch').click();
        await page.locator('#studentGrid .sp-student').first().waitFor();
        assert.equal(await page.locator('#studentSearch').inputValue(), '');
        if (width === 390) {
          await page.locator('#loadMore').scrollIntoViewIfNeeded();
          await page.waitForFunction(() => document.querySelectorAll('#studentGrid .sp-student').length === 35);
        }
        // Explicit theme choice survives reload and does not contain any credential.
        await page.locator('[data-theme-toggle]').first().click();
        const opposite = theme === 'dark' ? 'light' : 'dark';
        assert.equal(await page.locator('html').getAttribute('data-theme'), opposite);
        await page.reload();
        await page.locator('#studentGrid .sp-student').first().waitFor();
        assert.equal(await page.locator('html').getAttribute('data-theme'), opposite);
        await page.locator('[data-theme-toggle]').first().click();

        await page.goto(`${base}/spotlight/${first}`);
        await page.locator('[data-like-button]').waitFor();
        await checkPage(page, `Profile ${width} ${theme}`);
        await screenshot(page, `profile-${width}-${theme}`);
        await page.locator('#openNoteComposer').click();
        await page.locator('#noteText').waitFor();
        await page.locator('#noteText').fill('A layout test note');
        await checkPage(page, `Note sheet ${width} ${theme}`);
        await screenshot(page, `note-sheet-${width}-${theme}`);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#noteText').isVisible(), false);
        assert.equal(await page.locator('#openNoteComposer').evaluate(node => node === document.activeElement), true);

        await page.goto(`${base}/spotlight/admin`);
        await page.locator('#adminPassword').fill(loader.env.ADMIN_PASSWORD);
        await page.locator('#adminLoginButton').click();
        await page.locator('#adminView:not([hidden])').waitFor();
        await checkPage(page, `Admin ${width} ${theme}`);
        await screenshot(page, `admin-${width}-${theme}`);
        const reject = page.locator('.sp-admin-note button', { hasText: 'Reject' }).first();
        await reject.click();
        await page.locator('[data-confirm-accept]').waitFor();
        await checkPage(page, `Confirmation ${width} ${theme}`);
        await page.locator('[data-confirm-cancel]').click();
        for (const tab of ['reported', 'students', 'settings']) {
          await page.locator(`[data-admin-tab=${tab}]`).click();
          if (tab === 'settings') await page.locator('#setting-brand_name').waitFor({ state: 'attached' });
          await checkPage(page, `Admin ${tab} ${width} ${theme}`);
        }
        const group = page.locator('#setting-brand_name').locator('xpath=ancestor::details[1]');
        if (!(await group.evaluate(node => node.open))) await group.locator('summary').click();
        await page.locator('#setting-brand_name').fill('Unsaved preview');
        const count = page.locator('[data-unsaved-count]');
        await count.waitFor();
        assert.match(await count.textContent(), /1/);
        await checkPage(page, `Settings ${width} ${theme}`);
        await screenshot(page, `settings-${width}-${theme}`);
        assert.equal(await page.evaluate(() => sessionStorage.length), 0);
        assert.ok(await page.evaluate(() => Object.keys(localStorage).every(key => /theme/i.test(key))));
      } finally { await context.close(); }
    }
  }
  assert.deepEqual(errors, [], 'Browser layout checks should have no JavaScript errors');
  console.log('PASS: Discover, profile, note sheet and admin at 360/390/430/1440px in both themes, saved theme, search clearing, automatic pagination, custom confirmations and unsaved settings.');
}
module.exports = { runLayoutChecks };
