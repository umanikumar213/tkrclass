// Optional browser checks: node scripts/test-spotlight.js --browser
// Requires Playwright in the testing environment, not in the application's production dependencies.
const assert = require('node:assert/strict');

async function runBrowserChecks({ base, first, noPhoto, db, loader }) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const browserNetwork = '203.0.113.80';
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-forwarded-for': browserNetwork },
    });
    // Exercise the manual pagination fallback here; the layout matrix checks automatic pagination.
    await context.addInitScript(() => { delete window.IntersectionObserver; });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // No real network/font/Turnstile calls are necessary for these browser flows.
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.goto(`${base}/spotlight`);
    await page.locator('#studentGrid .sp-student').first().waitFor();
    assert.equal(await page.locator('#studentGrid .sp-student').count(), 30);
    assert.equal(await page.locator('#loadMore').isVisible(), true);
    await page.locator('#loadMore').click();
    await page.waitForFunction(() => document.querySelectorAll('#studentGrid .sp-student').length === 35);
    assert.equal(await page.locator('#loadMore').isVisible(), false);
    await page.locator('#filterSteps .sp-year-button').filter({ hasText: /1st/ }).click();
    await page.locator('#filterSteps select').first().selectOption('CIVIL');
    await page.waitForFunction(() => document.querySelectorAll('#studentGrid .sp-student').length === 1);
    assert.equal(await page.locator('.sp-filter-label', { hasText: 'Section' }).count(), 0);
    await page.locator('#studentSearch').fill(first.toLowerCase());
    await page.waitForTimeout(350);
    const countMirror = await context.newPage();
    await countMirror.goto(`${base}/spotlight`);
    await countMirror.locator('#studentSearch').fill(first);
    const mirrorCard = countMirror.locator(`[data-student-roll="${first}"] [data-card-like-count]`);
    await mirrorCard.waitFor();
    assert.match(await mirrorCard.textContent(), / 1$/);
    await countMirror.evaluate(() => { window.countMirrorMarker = true; });
    await page.locator('#studentGrid .sp-student').first().click();
    await page.locator('[data-like-button]').waitFor();
    assert.equal(await page.locator('.sp-profile-name').textContent(), 'Student <Unsafe & "Name">');
    assert.equal(await page.locator('.sp-profile-name script').count(), 0);
    // Browser context has its own signed identity and a different IP from the integration fixture.
    await page.locator('[data-like-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-like-button]').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('#profileLikeCount').textContent(), '2');
    assert.match(await page.locator('[data-like-button]').textContent(), /💘 Liked · 2/);
    assert.ok(!(await page.locator('[data-like-button]').textContent()).includes('+1'));
    const mirrorCount = async count => {
      await countMirror.waitForFunction(({ roll, count }) =>
        document.querySelector(`[data-student-roll="${roll}"] [data-card-like-count]`)?.textContent.endsWith(` ${count}`),
      { roll: first, count });
    };
    await mirrorCount(2);
    assert.equal(await countMirror.evaluate(() => window.countMirrorMarker), true, 'Card updates must not reload Discover');
    assert.equal((await (await context.request.get(`${base}/api/spotlight/students?q=${first}`)).json()).students[0].like_count, 1, 'The server list remains cached while the card updates');
    await countMirror.evaluate(roll => {
      document.querySelector(`[data-student-roll="${roll}"] [data-card-like-count]`).textContent = '0';
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }, first);
    await mirrorCount(2);
    await page.locator('[data-like-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-like-button]').getAttribute('aria-pressed') === 'false');
    await mirrorCount(1);
    await page.locator('[data-like-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-like-button]').getAttribute('aria-pressed') === 'true');
    await mirrorCount(2);
    await countMirror.reload();
    await countMirror.locator('#studentSearch').fill(first);
    await mirrorCount(2);
    await countMirror.close();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-like-button]')?.getAttribute('aria-pressed') === 'true');
    // A fresh private browsing context on the same network/device cannot add another like.
    const privateContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-forwarded-for': browserNetwork },
    });
    const privatePage = await privateContext.newPage();
    await privatePage.goto(`${base}/spotlight/${first}`);
    await privatePage.waitForFunction(() => document.querySelector('[data-like-button]')?.getAttribute('aria-pressed') === 'true');
    const blocked = privatePage.waitForResponse(r => r.url().endsWith('/like') && r.status() === 409);
    await privatePage.locator('[data-like-button]').click();
    await blocked;
    assert.equal(await privatePage.locator('#profileLikeCount').textContent(), '2');
    assert.equal(await privatePage.locator('[data-like-button]').getAttribute('aria-pressed'), 'true');
    assert.equal(await privatePage.evaluate(() => localStorage.getItem('spotlight-like-counts')), null, 'Blocked likes must not publish count overrides');
    await privateContext.close();
    await page.locator('#openNoteComposer').click();
    await page.locator('#noteText').fill('A kind browser test note');
    assert.equal(await page.locator('#noteCounter').textContent(), '24 / 200');
    await page.locator('#noteSubmit').click();
    await page.locator('#noteMessage.success').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#noteMessage').textContent(), 'Your note will appear after review.');
    await page.locator('#toast.show', { hasText: 'Your note will appear after review.' }).waitFor();
    const note = (await db.query(`SELECT id FROM spotlight_notes WHERE text='A kind browser test note'`)).rows[0];
    assert.ok(note);
    if (await page.locator('#noteSheet').isVisible()) await page.keyboard.press('Escape');
    await page.locator('button', { hasText: 'Share profile' }).click();
    // Chromium may expose navigator.share in some environments; inspect fallback when present.
    if (await page.locator('#shareDialogHost [role=dialog]').count()) {
      assert.ok((await page.locator('a', { hasText: 'WhatsApp' }).getAttribute('href')).startsWith('https://wa.me/?text='));
      await page.locator('#shareDialogHost [role=dialog] button', { hasText: 'Close' }).click();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const adminPage = await context.newPage();
    adminPage.on('pageerror', error => errors.push(error.message));
    await adminPage.goto(`${base}/spotlight/admin`);
    await adminPage.locator('#adminPassword').fill(loader.env.ADMIN_PASSWORD);
    await adminPage.locator('#adminLoginButton').click();
    await adminPage.locator('#adminView:not([hidden])').waitFor();
    const card = adminPage.locator('.sp-admin-note', { hasText: 'A kind browser test note' });
    await card.locator('button', { hasText: 'Approve' }).click();
    await card.waitFor({ state: 'detached' });
    await page.reload();
    const publicNote = page.locator(`[data-note-id="${note.id}"]`);
    await publicNote.waitFor();
    await publicNote.locator('[data-reaction=heart]').click();
    await publicNote.locator('[data-reaction=heart].is-selected').waitFor();
    await page.reload();
    await page.locator(`[data-note-id="${note.id}"] [data-reaction=heart].is-selected`).waitFor();
    await page.locator(`[data-note-id="${note.id}"] [data-report-menu]`).click();
    await page.locator(`[data-note-id="${note.id}"] [data-report]`).click();
    await page.locator('[data-confirm-accept]').click();
    await page.locator('#toast.show', { hasText: 'Thanks, an admin will review this note.' }).waitFor();
    assert.equal(await page.locator(`[data-note-id="${note.id}"]`).count(), 1);
    assert.equal(await page.locator(`[data-note-id="${note.id}"] [data-report]`).isDisabled(), true);
    await page.reload();
    await page.locator(`[data-note-id="${note.id}"]`).waitFor();
    assert.equal(await page.locator(`[data-note-id="${note.id}"] [data-report-menu]`).isDisabled(), true);
    assert.equal(await page.locator(`[data-note-id="${note.id}"] [data-report]`).isDisabled(), true, 'Reported action stays disabled after refresh');
    await adminPage.locator('[data-admin-tab=reported]').click();
    const report = adminPage.locator('.sp-admin-note', { hasText: 'A kind browser test note' });
    assert.match(await report.textContent(), /1/);
    await report.locator('button', { hasText: 'Keep note' }).click();
    await report.waitFor({ state: 'detached' });
    await adminPage.locator('[data-admin-tab=students]').click();
    await adminPage.locator('#adminContent input').fill(first);
    await adminPage.locator(`[data-roll="${first}"]`).waitFor();
    await require('./test-spotlight-avatar-browser').runAvatarBrowserChecks({ context, page, adminPage, base, first, noPhoto });
    await adminPage.locator(`[data-roll="${first}"][data-visibility-action=hide]`).click();
    await adminPage.locator(`[data-roll="${first}"][data-visibility-action=unhide]`).waitFor();
    await page.reload();
    await page.getByText('This profile is not available', { exact: true }).first().waitFor();
    await adminPage.locator(`[data-roll="${first}"][data-visibility-action=unhide]`).click();
    await adminPage.locator(`[data-roll="${first}"][data-visibility-action=hide]`).waitFor();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-like-button]')?.getAttribute('aria-pressed') === 'true');
    await page.locator('[data-like-button]').click();
    await page.waitForFunction(() => document.querySelector('[data-like-button]').getAttribute('aria-pressed') === 'false');
    await adminPage.locator('[data-admin-tab=settings]').click();
    const openSetting = async key => {
      const field = adminPage.locator(`#setting-${key}`);
      await field.waitFor({ state: 'attached' });
      const group = field.locator('xpath=ancestor::details[1]');
      if (await group.count() && !(await group.evaluate(node => node.open))) await group.locator('summary').click();
      return field;
    };
    await openSetting('brand_name');
    const saveSettings = async () => {
      const outgoing = adminPage.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/admin/settings'));
      const response = adminPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/admin/settings'));
      await adminPage.locator('.sp-settings-save').click();
      const body = (await outgoing).postDataJSON();
      assert.equal((await response).status(), 200);
      await adminPage.waitForFunction(() => {
        const button = document.querySelector('.sp-settings-save');
        return button && button.disabled && !document.querySelector('#adminContent input:disabled');
      });
      return body.changes;
    };
    await (await openSetting('brand_name')).fill('Campus <Edited>');
    assert.equal(await adminPage.locator('#setting-brand_name').inputValue(), 'Campus <Edited>');
    assert.deepEqual(await saveSettings(), { brand_name: 'Campus <Edited>' });
    await page.goto(`${base}/spotlight`);
    await page.locator('.sp-brand-name', { hasText: 'Campus <Edited>' }).waitFor();
    assert.equal(await page.locator('.sp-brand-name edited').count(), 0);
    await openSetting('brand_name');
    await adminPage.locator('.sp-settings-field', { has: adminPage.locator('#setting-brand_name') }).locator('.sp-settings-reset').click();
    assert.equal(await adminPage.locator('#setting-brand_name').inputValue(), 'TKR Spotlight');
    assert.deepEqual(await saveSettings(), { brand_name: null });
    await page.reload();
    await page.locator('.sp-brand-name', { hasText: 'TKR Spotlight' }).waitFor();
    await openSetting('like_device_check');
    assert.equal(await adminPage.locator('#setting-like_device_check').isChecked(), true);
    const years = adminPage.locator('#setting-random_profile_years');
    await years.locator('input[data-year="1st Year"]').check();
    await years.locator('input[data-year="3rd Year"]').uncheck();
    await years.locator('input[data-year="4th Year"]').uncheck();
    assert.deepEqual(await saveSettings(), { random_profile_years: ['1st Year'] });
    const firstRandom = await context.request.get(`${base}/api/spotlight/random`);
    assert.equal(firstRandom.status(), 200);
    const roll1 = (await firstRandom.json()).roll_number;
    const nextRandom = await context.request.get(`${base}/api/spotlight/random`);
    assert.equal(nextRandom.status(), 200);
    assert.notEqual((await nextRandom.json()).roll_number, roll1);
    await openSetting('random_profile_years');
    await adminPage.locator('.sp-settings-field', { has: adminPage.locator('#setting-random_profile_years') }).locator('.sp-settings-reset').click();
    assert.deepEqual(await saveSettings(), { random_profile_years: null });
    await adminPage.locator('#adminLogout').click();
    await adminPage.locator('#adminLoginView:not([hidden])').waitFor();
    assert.equal(await adminPage.locator('#adminPassword').inputValue(), '');
    assert.equal(await adminPage.evaluate(() => sessionStorage.length), 0);
    assert.ok(await adminPage.evaluate(() => Object.keys(localStorage).every(key => ['spotlight-reported-notes', 'spotlight-like-counts'].includes(key))));
    assert.ok(await adminPage.evaluate(() => Object.values(JSON.parse(localStorage.getItem('spotlight-like-counts') || '{}'))
      .every(entry => Object.keys(entry).sort().join(',') === 'at,count')), 'Only public counts and freshness timestamps may be cached');
    assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
    await require('./test-spotlight-layouts').runLayoutChecks({ browser, base, first, db, loader });
    console.log('PASS: phone browser discovery, pagination, safe text, persistent likes/reactions, note review, reporting, sharing, visibility controls, and logout.');
  } finally { await browser.close(); }
}
module.exports = { runBrowserChecks };
