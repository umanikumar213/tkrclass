const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const BASE  = 'http://103.171.190.44/TKRCET';
const LOGIN = `${BASE}/`;

// Resolve a possibly-relative URL against a base.
const abs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

app.post('/login', async (req, res) => {
  const roll = (req.body.rollNumber || '').trim();
  if (!roll) return res.json({ success: false, message: 'No roll number provided' });

  try {
    // One cookie jar per login = its own session.
    const jar = new CookieJar();
    const client = wrapper(axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 5,
      validateStatus: s => s < 500,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      },
      timeout: 30000
    }));

    // ── Step 1: GET the login page and read its form ──
    const loginPage = await client.get(LOGIN);
    fs.writeFileSync('login-page.html', loginPage.data);

    const $ = cheerio.load(loginPage.data);
    const form = $('form').first();
    const action = abs(form.attr('action') || '', LOGIN) || LOGIN;

    const payload = {};
    let userField = '', passField = '';
    form.find('input').each((i, el) => {
      const name = $(el).attr('name');
      if (!name) return;
      const type = ($(el).attr('type') || 'text').toLowerCase();
      const val  = $(el).attr('value') || '';
      if (type === 'password')              { payload[name] = roll; passField = name; }
      else if (type === 'submit' || type === 'button') { payload[name] = val; }  // include even if empty
      else if (type === 'hidden')           { payload[name] = val; }
      else                                  { payload[name] = roll; userField = name; }  // text/email = username
    });
    // <button name="login"> submit buttons: the browser sends their name on click.
    form.find('button').each((i, el) => {
      const name = $(el).attr('name');
      const type = ($(el).attr('type') || 'submit').toLowerCase();
      if (name && type === 'submit') payload[name] = $(el).attr('value') || '';
    });

    console.log('Login form →', { action, userField, passField, fields: Object.keys(payload) });

    if (!userField || !passField) {
      return res.json({
        success: false,
        message: 'Could not read the login form. Upload login-page.html so I can see the field names.'
      });
    }

    // ── Step 2: POST the credentials ──
    const loginRes = await client.post(action, new URLSearchParams(payload).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': LOGIN }
    });
    const afterUrl = loginRes.request?.res?.responseUrl || action;
    console.log('After login →', afterUrl, '| status', loginRes.status, '| len', String(loginRes.data).length);

    // ── Step 3: load the main page, following any redirect to the frameset ──
    let mainUrl  = afterUrl;
    let mainHtml = String(loginRes.data);

    // If we're still looking at the login form (and NOT being redirected), credentials were rejected.
    const hasRedirectScript = /document\.location|location\.href|location\.replace|location\s*=|http-equiv=["']?refresh/i.test(mainHtml);
    if (!hasRedirectScript && /name=["']password["']/i.test(mainHtml) && /Login to Academic Activity Portal/i.test(mainHtml)) {
      fs.writeFileSync('after-login.html', mainHtml);
      return res.json({ success: false, message: 'Login was rejected — the portal still shows the login form. Double-check the roll number / password.' });
    }

    // Follow meta-refresh or JavaScript redirects (the success page bounces to MainFrameset.php).
    const findRedirect = (html, base) => {
      let m = html.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i);
      if (m) return abs(m[1], base);
      m = html.match(/(?:window\.|top\.|self\.|parent\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i)
        || html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
      if (m) return abs(m[1], base);
      return null;
    };
    for (let i = 0; i < 4; i++) {
      const next = findRedirect(mainHtml, mainUrl);
      if (!next) break;
      try { const r = await client.get(next, { headers: { Referer: mainUrl } }); mainUrl = next; mainHtml = String(r.data); }
      catch { break; }
    }

    // If there are no real <frame> tags yet, load the frameset explicitly.
    if (!/<frame\b/i.test(mainHtml)) {
      try { const r = await client.get(`${BASE}/MainFrameset.php`, { headers: { Referer: mainUrl } });
            mainUrl = `${BASE}/MainFrameset.php`; mainHtml = String(r.data); } catch {}
    }
    fs.writeFileSync('after-login.html', mainHtml);

    // ── Step 4: gather pages to read — all frames + any "Attendance" link ──
    const toFetch = new Set();
    // Known attendance/personal-details page (menu link is built by JS, so add it directly):
    toFetch.add(`${BASE}/StudentInformationForStudent.php`);
    const $m = cheerio.load(mainHtml);
    $m('frame, iframe').each((i, el) => {
      const src = abs($m(el).attr('src') || '', mainUrl);
      if (src) toFetch.add(src);
    });

    // Read the frames, and inside them look for the Attendance link.
    let dump = '';
    let attendanceHtml = '';
    const visited = new Set();
    const readPage = async (url) => {
      if (!url || visited.has(url)) return '';
      visited.add(url);
      try {
        const r = await client.get(url, { headers: { 'Referer': mainUrl } });
        const html = String(r.data);
        if (/StudentInformationForStudent\.php/i.test(url)) attendanceHtml = html;
        const $p = cheerio.load(html);
        // find an Attendance link in this page
        $p('a').each((i, el) => {
          const t = $p(el).text().trim().toLowerCase();
          const href = abs($p(el).attr('href') || '', url);
          if (href && (t.includes('attendance') || t.includes('personal details'))) {
            toFetch.add(href);
          }
        });
        const text = $p('body').text().replace(/\n{3,}/g, '\n\n').trim();
        return `\n===== PAGE: ${url} =====\n${text}\n`;
      } catch (e) { return `\n===== PAGE: ${url} (error: ${e.message}) =====\n`; }
    };

    // first pass: frames (this may add the attendance link to toFetch)
    for (const url of [...toFetch]) dump += await readPage(url);
    // second pass: anything newly discovered (e.g. the attendance page)
    for (const url of [...toFetch]) dump += await readPage(url);

    fs.writeFileSync('attendance.txt', dump || '(no frame/page text captured)');

    // ── Step 5: parse roll, name, overall % and subject-wise attendance ──
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const roll_no = (dump.match(/Roll No:\s*([A-Z0-9]+)/i) || [])[1] || roll;
    const name    = clean((dump.match(/Name:\s*([^\n]+?)(?:\s{2,}|Father Name:|$)/i) || [])[1]) || '';
    // Totals row: "126 77 49 61.11%"
    const totals = dump.match(/(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)%/);
    const summary = totals
      ? { conducted: +totals[1], present: +totals[2], absent: +totals[3], percentage: totals[4] }
      : null;

    // Overall % = the totals-row percentage (most reliable).
    const overall = summary ? summary.percentage : ((dump.match(/([\d.]+)%/) || [])[1] || '');

    // Subject-wise: pair each subject abbreviation with its "present/conducted" cell.
    const subjAbbr = (dump.match(/Subject Abrevation([\s\S]*?)Cons\. Total/i) || [])[1] || '';
    const subjects = subjAbbr.split('\n').map(clean).filter(Boolean);
    const ratios = (dump.match(/Attendance\s*([\s\S]*?)\d+\s+\d+\s+\d+\s+[\d.]+%/i) || [])[1] || '';
    const ratioList = (ratios.match(/\d+\/\d+|\b0\b/g) || []);
    const perSubject = [];
    for (let i = 0; i < Math.min(subjects.length, ratioList.length); i++) {
      perSubject.push({ subject: subjects[i], attended: ratioList[i] });
    }

    // ── Latest day's per-period status (from the Daywise table, with merged cells expanded) ──
    let latestDay = null;
    if (attendanceHtml) {
      const $a = cheerio.load(attendanceHtml);
      let dayTable = null;
      $a('table').each((i, t) => {
        const head = clean($a(t).text());
        // the daywise table header has "Date" and "WeekDay" (one word), unlike the timetable's "Week Day/Time"
        if (/WeekDay/.test(head) && /Date/.test(head)) dayTable = t;
      });
      if (dayTable) {
        $a(dayTable).find('tr').each((i, tr) => {
          if (latestDay) return; // first data row = most recent date
          const tds = $a(tr).find('td');
          if (tds.length < 2) return;
          const dateTxt = clean($a(tds[0]).text());
          if (!/^\d{2}-\d{2}-\d{4}$/.test(dateTxt)) return;
          const weekday = clean($a(tds[1]).text());
          const periods = [];
          for (let k = 2; k < tds.length; k++) {
            const cell = $a(tds[k]);
            const span = parseInt(cell.attr('colspan') || '1', 10);
            const txt = clean(cell.text());
            let status = 'dash', subject = '';
            if (/present/i.test(txt)) status = 'present';
            else if (/absent/i.test(txt)) status = 'absent';
            const sm = txt.match(/\(([^)]+)\)/); if (sm) subject = sm[1];
            for (let s = 0; s < span; s++) periods.push({ status, subject });
          }
          while (periods.length < 6) periods.push({ status: 'dash', subject: '' });
          latestDay = { date: dateTxt, weekday, periods: periods.slice(0, 6) };
        });
      }
    }

    console.log('Saved → login-page.html, after-login.html, attendance.txt');
    console.log('──── CAPTURED TEXT (first 1500 chars) ────');
    console.log((dump || '').slice(0, 1500));
    console.log('──── END ────');

    return res.json({
      success: true,
      rollNo: roll_no,
      name,
      overall,
      summary,
      perSubject,
      latestDay,
      message: 'Attendance loaded.'
    });

  } catch (err) {
    console.error('ERROR:', err.message);
    return res.json({ success: false, message: err.message });
  }
});

app.listen(3000, () => console.log('✅ Server at http://localhost:3000  (no Chrome needed)'));