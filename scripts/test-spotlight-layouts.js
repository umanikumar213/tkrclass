// Uses only the existing disposable Spotlight test schema and synthetic student fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runLayoutChecks({ browser, base, first, db, loader }) {
  const output = path.resolve(__dirname, '../generated-artifacts/spotlight-layouts');
  await fs.mkdir(output, { recursive: true });
  // Four real year values and a multi-section branch exercise the full filter row.
  for (const [suffix, year, section] of [['04', '4th Year', 'A'], ['05', '3rd Year', 'A'], ['06', '2nd Year', 'A'], ['07', '4th Year', 'B']]) {
    await db.query('UPDATE spotlight_students SET year=$2,section=$3 WHERE roll_number=$1', [`26K91A01${suffix}`, year, section]);
  }
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
        widestPhoto: Math.max(0, ...[...document.querySelectorAll('img[src*=\"/api/spotlight/photo/\"],img[src*=\"/api/spotlight/avatar/\"]')].map(img => img.getBoundingClientRect().width)),
      };
    });
    assert.ok(metrics.scrollWidth <= metrics.width, `${label}: horizontal page overflow (${metrics.scrollWidth}/${metrics.width})`);
    assert.match(metrics.family, /Plus Jakarta Sans/, `${label}: expected requested font`);
    assert.deepEqual(metrics.externalScripts, [], `${label}: no third-party JavaScript`);
    assert.ok(metrics.widestPhoto <= 140, `${label}: student photo is wider than 140px (${metrics.widestPhoto})`);
    assert.equal(await page.locator('[data-theme-toggle]').count(), 0, 'Theme toggles must be removed');
    assert.equal(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme), 'light');
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
        await checkPage(page, `Discover ${width} ${theme}`);
        assert.equal(await page.locator('#studentGrid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), width < 768 ? 1 : width < 1100 ? 2 : 3);
        // The leaderboard precedes the directory in the actual document, not just visually.
        assert.equal(await page.evaluate(() => Boolean(document.querySelector('#leaderboard').compareDocumentPosition(document.querySelector('#studentGrid')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
        await screenshot(page, `discover-${width}-${theme}`);
        await page.locator('#studentGrid .sp-student').first().scrollIntoViewIfNeeded();
        const card = page.locator('#studentGrid .sp-student').first();
        assert.ok((await card.boundingBox()).height >= 88);
        assert.equal((await card.locator('.sp-avatar').boundingBox()).width, 72);
        assert.equal(await card.locator('img').getAttribute('width'), '72');
        await screenshot(page, `directory-${width}-${theme}`);
        await page.locator('#studentSearch').fill('Missing student');
        await page.waitForTimeout(350);
        await page.locator('#studentGrid .sp-state').waitFor();
        await page.locator('#clearStudentSearch').click();
        await page.locator('#studentGrid .sp-student').first().waitFor();
        assert.equal(await page.locator('#studentSearch').inputValue(), '');
        if (width === 390) {
          let failedPageRequests = 0;
          if (theme === 'dark') {
            await page.route('**/api/spotlight/students?*', route => {
              if (new URL(route.request().url()).searchParams.get('page') !== '2') return route.continue();
              failedPageRequests++;
              return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Temporary test failure"}' });
            });
          }
          await page.locator('#loadMore').scrollIntoViewIfNeeded();
          if (theme === 'dark') {
            await page.locator('[data-list-error]').waitFor();
            await page.waitForTimeout(400);
            assert.equal(failedPageRequests, 1, 'Infinite scrolling must not retry failed pages in a loop');
            await page.unroute('**/api/spotlight/students?*');
            await page.locator('[data-list-error] button').click();
          }
          await page.waitForFunction(() => document.querySelectorAll('#studentGrid .sp-student').length === 35);
        }
        await checkFilters(page);

        await page.goto(`${base}/spotlight/${first}`);
        await page.locator('[data-like-button]').waitFor();
        await checkPage(page, `Profile ${width} ${theme}`);
        assert.equal(await page.locator('.sp-profile-backdrop img').count(), 0, 'Profile photo must not be used as a stretched backdrop');
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
        assert.ok((await page.locator('#setting-brand_name').boundingBox()).height >= 44, 'Settings inputs need phone-sized touch targets');
        const count = page.locator('[data-unsaved-count]');
        await count.waitFor();
        assert.match(await count.textContent(), /1/);
        await checkPage(page, `Settings ${width} ${theme}`);
        await screenshot(page, `settings-${width}-${theme}`);
        assert.equal(await page.evaluate(() => sessionStorage.length), 0);
        assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => /theme/i.test(key))), false);
      } finally { await context.close(); }
    }
  }
  assert.deepEqual(errors, [], 'Browser layout checks should have no JavaScript errors');
  await runChallengeChecks({ browser, base, first, loader });
  console.log('PASS: light-only Discover, profile, note sheet and admin at 360/390/430/1440px under both OS preferences; compact photos, complete year controls, dropdowns, pagination and settings.');
}

async function checkFilters(page) {
  await page.evaluate(() => scrollTo(0, 0));
  const row = page.locator('.sp-year-row');
  assert.equal(await row.locator('button').count(), 5, 'All four data years must be available');
  assert.equal(await row.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'Year control must never scroll horizontally');
  const fourth = row.locator('button').filter({ hasText: /4th/ });
  assert.equal(await fourth.isVisible(), true);
  const fourthBox = await fourth.boundingBox();
  assert.ok(fourthBox.x >= 0 && fourthBox.x + fourthBox.width <= page.viewportSize().width, 'Fourth year must fit on screen');
  const change = async action => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/spotlight/students' && response.status() === 200);
    await action();
    await response;
    await page.locator('#studentGrid .sp-student').first().waitFor();
  };
  await change(() => fourth.click());
  await page.waitForFunction(() => document.querySelectorAll('#studentGrid .sp-student').length === 2);
  const branch = page.locator('.sp-filter-select').first();
  assert.equal((await branch.boundingBox()).height, 44);
  assert.deepEqual(await branch.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['', 'CSE']);
  await change(() => branch.selectOption('CSE'));
  const section = page.locator('.sp-filter-select').nth(1);
  assert.deepEqual(await section.locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['', 'A', 'B']);
  await change(() => section.selectOption('B'));
  await page.waitForFunction(() => document.querySelectorAll('#studentGrid .sp-student').length === 1);
  assert.equal(await page.locator('.sp-clear-filters').isVisible(), true);
  await change(() => row.locator('button').filter({ hasText: /1st/ }).click());
  assert.equal(await branch.inputValue(), '', 'Year changes reset branch');
  await change(() => branch.selectOption('CIVIL'));
  assert.equal(await page.locator('.sp-filter-select').count(), 1, 'NULL-only branch must hide the Section dropdown');
  await change(() => page.locator('.sp-clear-filters').click());
  assert.equal(await page.locator('.sp-clear-filters').count(), 0);
  assert.equal(await branch.inputValue(), '');
  assert.equal(await row.locator('button[aria-pressed=\"true\"]').textContent(), 'All');
}

async function runChallengeChecks({ browser, base, first, loader }) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 844 }, extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.100' },
  });
  loader.env.TURNSTILE_SITE_KEY = 'test-site-key';
  loader.env.TURNSTILE_SECRET = 'test-secret';
  try {
    const page = await context.newPage();
    await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?*', route => route.fulfill({
      contentType: 'application/javascript',
      body: `window.challengeExecutions=0;window.turnstile={
        render(node,options){window.challengeOptions=options;window.challengeNode=node;
          const widget=document.createElement('div');widget.textContent='Test security widget';
          node.append(widget);return 1;},
        execute(){window.challengeExecutions++;
          window.challengeWasVisible=document.querySelector('#spotlightSecurityDialog').open &&
            window.challengeNode.getBoundingClientRect().width>0;
          setTimeout(()=>window.challengeOptions.callback('valid-test-token'),30);},
        reset(){}
      };`,
    }));
    await page.goto(`${base}/spotlight/${first}`);
    await page.locator('[data-like-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-like-button]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await page.evaluate(() => window.challengeWasVisible), true, 'Like security check must not be trapped inside the hidden note composer');
    assert.equal(await page.locator('#spotlightSecurityDialog').evaluate(node => node.open), false);
    await page.locator('#openNoteComposer').click();
    await page.locator('#noteText').fill('A verified challenge test note');
    await page.locator('#noteSubmit').click();
    await page.locator('#toast.show', { hasText: 'Your note will appear after review.' }).waitFor();
    assert.equal(await page.evaluate(() => window.challengeExecutions), 1, 'Remembered verification should avoid another challenge for the note');
    await page.locator('[data-like-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-like-button]')?.getAttribute('aria-pressed') === 'false');
    assert.equal(await page.evaluate(() => window.challengeExecutions), 1);
    // A blocked storage API must not break reporting or the rest of the profile.
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('Storage disabled for this test'); };
      Storage.prototype.setItem = () => { throw new Error('Storage disabled for this test'); };
    });
    await page.reload();
    const reportCard = page.locator('[data-note-id]').first();
    await reportCard.locator('[data-report-menu]').click();
    await reportCard.locator('[data-report]').click();
    await page.locator('[data-confirm-accept]').click();
    await page.locator('#toast.show', { hasText: 'Thanks, an admin will review this note.' }).waitFor();
    assert.equal(await reportCard.isVisible(), true);
    assert.equal(await reportCard.locator('[data-report]').isDisabled(), true);
    console.log('PASS: managed security check stays visible outside the note sheet and remembered verification works across likes and notes.');
  } finally {
    delete loader.env.TURNSTILE_SITE_KEY;
    delete loader.env.TURNSTILE_SECRET;
    await context.close();
  }
}
module.exports = { runLayoutChecks };
