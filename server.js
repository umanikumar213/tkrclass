const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(require('./chat'));
app.use(express.static('public'));

const BASE  = 'http://103.171.190.44/TKRCET';
const LOGIN = `${BASE}/`;
const abs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

// Short-lived cache so repeat checks of the same roll don't hammer the slow portal.
const CACHE = new Map();          // roll -> { at, data }
const CACHE_MS = 60 * 1000;       // 60 seconds

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 10,               // 10 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again in a minute.' }
});

app.post('/login', loginLimiter, async (req, res) => {
  const roll = (req.body.rollNumber || '').trim();
  if (!roll) return res.json({ success: false, message: 'No roll number provided' });

  const cached = CACHE.get(roll.toUpperCase());
  if (cached && (Date.now() - cached.at) < CACHE_MS) {
    console.log(`[${new Date().toISOString()}] ROLL ${roll.toUpperCase()} → served from cache`);
    return res.json({ ...cached.data, cached: true });
  }
  console.log(`[${new Date().toISOString()}] ROLL ${roll.toUpperCase()} → fetching live from portal`);

  try {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
      jar, withCredentials: true, maxRedirects: 5, validateStatus: s => s < 500,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      timeout: 30000
    }));

    // Step 1: login form
    const loginPage = await client.get(LOGIN);
    const $ = cheerio.load(loginPage.data);
    const form = $('form').first();
    const action = abs(form.attr('action') || '', LOGIN) || LOGIN;
    const payload = {};
    let userField = '', passField = '';
    form.find('input').each((i, el) => {
      const name = $(el).attr('name'); if (!name) return;
      const type = ($(el).attr('type') || 'text').toLowerCase();
      const val = $(el).attr('value') || '';
      if (type === 'password') { payload[name] = roll; passField = name; }
      else if (type === 'submit' || type === 'button') { payload[name] = val; }
      else if (type === 'hidden') { payload[name] = val; }
      else { payload[name] = roll; userField = name; }
    });
    form.find('button').each((i, el) => {
      const name = $(el).attr('name');
      const type = ($(el).attr('type') || 'submit').toLowerCase();
      if (name && type === 'submit') payload[name] = $(el).attr('value') || '';
    });
    if (!userField || !passField) return res.json({ success: false, message: 'Could not read the login form.' });

    // Step 2: post credentials
    const loginRes = await client.post(action, new URLSearchParams(payload).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': LOGIN }
    });
    const afterUrl = loginRes.request?.res?.responseUrl || action;

    // Step 3: follow redirect to the frameset
    let mainUrl = afterUrl, mainHtml = String(loginRes.data);

    // Portal rejects wrong credentials with an "Invalid Details" alert.
    if (/invalid\s*details/i.test(mainHtml)) {
      console.log(`[${new Date().toISOString()}] ROLL ${roll.toUpperCase()} → invalid details`);
      return res.json({ success: false, message: 'Invalid details. Please check your roll number.' });
    }

    const hasRedirectScript = /document\.location|location\.href|location\.replace|location\s*=|http-equiv=["']?refresh/i.test(mainHtml);
    if (!hasRedirectScript && /name=["']password["']/i.test(mainHtml) && /Login to Academic Activity Portal/i.test(mainHtml)) {
      return res.json({ success: false, message: 'Invalid details. Please check your roll number.' });
    }
    const findRedirect = (html, base) => {
      let m = html.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i);
      if (m) return abs(m[1], base);
      m = html.match(/(?:window\.|top\.|self\.|parent\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i)
        || html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
      if (m) return abs(m[1], base);
      return null;
    };
    for (let i = 0; i < 4; i++) {
      const next = findRedirect(mainHtml, mainUrl); if (!next) break;
      try { const r = await client.get(next, { headers: { Referer: mainUrl } }); mainUrl = next; mainHtml = String(r.data); } catch { break; }
    }
    if (!/<frame\b/i.test(mainHtml)) {
      try { const r = await client.get(`${BASE}/MainFrameset.php`, { headers: { Referer: mainUrl } }); mainUrl = `${BASE}/MainFrameset.php`; mainHtml = String(r.data); } catch {}
    }

    // Step 4: go straight to the attendance page (no need to crawl every frame)
    let dump = '', attendanceHtml = '';
    try {
      const r = await client.get(`${BASE}/StudentInformationForStudent.php`, { headers: { 'Referer': mainUrl } });
      attendanceHtml = String(r.data);
      dump = cheerio.load(attendanceHtml)('body').text().replace(/\n{3,}/g, '\n\n').trim();
    } catch (e) { /* leave dump empty → handled below */ }

    // If the attendance page never loaded real data, the login didn't truly succeed → invalid.
    if (!dump || /invalid\s*details/i.test(attendanceHtml) || !/Roll No:/i.test(dump)) {
      console.log(`[${new Date().toISOString()}] ROLL ${roll.toUpperCase()} → invalid details`);
      return res.json({ success: false, message: 'Invalid details. Please check your roll number.' });
    }

    // Step 5: parse
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const roll_no = (dump.match(/Roll No:\s*([A-Z0-9]+)/i) || [])[1] || roll;
    const name = clean((dump.match(/Name:\s*([^\n]+?)(?:\s{2,}|Father Name:|$)/i) || [])[1]) || '';
    const totals = dump.match(/(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)%/);
    const summary = totals ? { conducted: +totals[1], present: +totals[2], absent: +totals[3], percentage: totals[4] } : null;
    const overall = summary ? summary.percentage : ((dump.match(/([\d.]+)%/) || [])[1] || '');

    const subjAbbr = (dump.match(/Subject Abrevation([\s\S]*?)Cons\. Total/i) || [])[1] || '';
    const subjects = subjAbbr.split('\n').map(clean).filter(Boolean);
    const ratios = (dump.match(/Attendance\s*([\s\S]*?)\d+\s+\d+\s+\d+\s+[\d.]+%/i) || [])[1] || '';
    const ratioList = (ratios.match(/\d+\/\d+|\b0\b/g) || []);
    const perSubject = [];
    for (let i = 0; i < Math.min(subjects.length, ratioList.length); i++) perSubject.push({ subject: subjects[i], attended: ratioList[i] });

    let latestDay = null;
    let streak = 0;
    if (attendanceHtml) {
      const $a = cheerio.load(attendanceHtml);
      let dayTable = null;
      $a('table').each((i, t) => { const head = clean($a(t).text()); if (/WeekDay/.test(head) && /Date/.test(head)) dayTable = t; });
      if (dayTable) {
        const days = [];
        $a(dayTable).find('tr').each((i, tr) => {
          const tds = $a(tr).find('td'); if (tds.length < 2) return;
          const dateTxt = clean($a(tds[0]).text());
          if (!/^\d{2}-\d{2}-\d{4}$/.test(dateTxt)) return;
          const weekday = clean($a(tds[1]).text());
          const periods = [];
          for (let k = 2; k < tds.length; k++) {
            const cell = $a(tds[k]); const span = parseInt(cell.attr('colspan') || '1', 10);
            const txt = clean(cell.text()); let status = 'dash', subject = '';
            if (/present/i.test(txt)) status = 'present'; else if (/absent/i.test(txt)) status = 'absent';
            const sm = txt.match(/\(([^)]+)\)/); if (sm) subject = sm[1];
            for (let s = 0; s < span; s++) periods.push({ status, subject });
          }
          while (periods.length < 6) periods.push({ status: 'dash', subject: '' });
          days.push({ date: dateTxt, weekday, periods: periods.slice(0, 6) });
        });

        if (days.length) latestDay = days[0]; // table is newest-first

        // Streak: from newest day backwards, count days where EVERY real period is Present.
        // A single Absent period breaks it. Days with no marked periods (all dash) are skipped.
        for (const d of days) {
          const marked = d.periods.filter(p => p.status !== 'dash');
          if (marked.length === 0) continue;          // nothing happened that day → skip, don't break
          if (marked.some(p => p.status === 'absent')) break; // any absent → streak ends
          streak++;                                    // all present → counts
        }
      }
    }

    const result = { success: true, rollNo: roll_no, name, overall, summary, perSubject, latestDay, streak };
    CACHE.set(roll.toUpperCase(), { at: Date.now(), data: result });
    return res.json(result);
  } catch (err) {
    console.error("[/login] scraper error:", err);
    return res.json({ success: false, message: "Could not reach the attendance portal. Please try again." });
  }
});

const PORT = process.env.PORT || 5000;
const { initDb } = require('./chat');
initDb()
  .then(() => app.listen(PORT, () => console.log('✅ Server running on port ' + PORT)))
  .catch(err => { console.error('❌ DB init failed, refusing to start:', err.message); process.exit(1); });
