#!/usr/bin/env node
'use strict';

// Standalone authorized export. Never mounted in the public application.
const fs = require('node:fs/promises');
const path = require('node:path');
const axios = require('axios');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const FIELDS = ['name', 'roll_number', 'course', 'section', 'year'];
const ALIASES = {
  name: ['student name', 'name of the student', 'name'],
  roll_number: ['roll no', 'roll number', 'rollno', 'hall ticket no', 'hall ticket number', 'ht no'],
  course: ['course', 'course name', 'programme', 'program', 'branch', 'branch name'],
  section: ['section', 'sec'],
  year: ['year', 'study year', 'year of study', 'current year'],
};
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const labelKey = value => clean(value).toLowerCase().replace(/[.:：]+$/g, '').trim();
const labelField = value => Object.keys(ALIASES).find(key => ALIASES[key].includes(labelKey(value)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readRolls(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const rolls = new Set();
  const suffixes = [
    ...Array.from({ length: 100 }, (_, n) => String(n).padStart(2, '0')),
    ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ').flatMap(letter =>
      Array.from({ length: 10 }, (_, n) => `${letter}${n}`)),
  ];
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i].toUpperCase();
    if (/^[A-Z0-9]{8}$/.test(entry)) {
      for (const suffix of suffixes) rolls.add(entry + suffix);
    } else if (/^[A-Z0-9]{10}$/.test(entry)) {
      rolls.add(entry);
    } else {
      throw new Error(`Invalid format at input entry ${i + 1}. Use one 8-character series prefix or 10-character full roll number per line.`);
    }
  }
  if (!lines.length) throw new Error('The input file contains no roll numbers.');
  return [...rolls];
}

function parseProfile(html, expectedRoll) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const result = Object.fromEntries(FIELDS.map(field => [field, '']));
  // Read only labeled values. Do not collect photos, attendance or contact details.
  function setValue(field, value) {
    const text = clean(value).replace(/^[:：]\s*/, '');
    if (field && text && !labelField(text) && !result[field]) result[field] = text;
  }
  $('tr').each((_, tr) => {
    const cells = $(tr).children('td,th');
    cells.each((index, cell) => {
      // Ignore outer layout cells that contain a nested table.
      if ($(cell).find('table').length) return;
      const value = clean($(cell).text());
      const field = labelField(value);
      if (field) {
        const next = cells.eq(index + 1);
        if (clean(next.text()) === ':') setValue(field, cells.eq(index + 2).text());
        else setValue(field, next.text());
      } else {
        const match = value.match(/^([^:：]+)[:：]\s*(.+)$/);
        if (match) setValue(labelField(match[1]), match[2]);
      }
    });
  });
  $('dt,label').each((_, el) => {
    const field = labelField($(el).text());
    if (field) setValue(field, $(el).next().text());
  });
  // Support older pages with all labeled values in one line.
  const labels = Object.values(ALIASES).flat().sort((a, b) => b.length - a.length);
  const escaped = labels.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const bodyText = $('body').text().replace(/\r/g, '');
  const regex = new RegExp(`(?:^|[\\s])(${escaped})\\s*[:：]\\s*([^\\n]*?)(?=\\s+(?:${escaped}|father(?:'s)? name|mother(?:'s)? name|gender|date of birth|semester|mobile|email)\\s*[:：]|\\n|$)`, 'gi');
  for (const match of bodyText.matchAll(regex)) setValue(labelField(match[1]), match[2]);
  result.roll_number = result.roll_number.toUpperCase();
  if (result.roll_number !== expectedRoll.toUpperCase()) throw new Error('Returned profile does not match the requested roll number. Stopped to avoid mixing records.');
  return result;
}

function options(argv) {
  const out = { base: 'http://103.171.190.44/TKRCET/', delay: 10000, requestDelay: 2000, output: 'generated-artifacts/alumni', allowHttp: false };
  const values = { '--rolls': 'rolls', '--base-url': 'base', '--output': 'output', '--delay-ms': 'delay', '--request-delay-ms': 'requestDelay' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') out.help = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--allow-http') out.allowHttp = true;
    else if (values[arg] && argv[i + 1] && !argv[i + 1].startsWith('--')) out[values[arg]] = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  for (const key of ['delay', 'requestDelay']) {
    out[key] = Number(out[key]);
    if (!Number.isFinite(out[key]) || out[key] < (key === 'delay' ? 5000 : 1000)) throw new Error('Use at least 5000ms between students and 1000ms between HTTP requests.');
  }
  return out;
}

async function collectStudent(roll, config) {
  const base = new URL(config.base.endsWith('/') ? config.base : `${config.base}/`);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Use a plain HTTP(S) portal URL without credentials.');
  if (base.protocol === 'http:' && !config.allowHttp) throw new Error('Portal uses unencrypted HTTP. Use approved HTTPS, or --allow-http only on the trusted college network.');
  const jar = new CookieJar(); // A fresh, isolated login session for each student.
  const client = wrapper(axios.create({
    jar, withCredentials: true, timeout: 30000, maxRedirects: 5,
    maxContentLength: 4 * 1024 * 1024,
    validateStatus: () => true,
    headers: { 'User-Agent': 'College-authorized-alumni-export/1.0' },
    beforeRedirect(opts) {
      if (`${opts.protocol}//${opts.hostname}${opts.port ? `:${opts.port}` : ''}` !== base.origin) {
        throw new Error('Off-origin redirect blocked.');
      }
    },
  }));
  let lastRequest = 0;
  function safeUrl(value, relativeTo = base.href) {
    const url = new URL(value, relativeTo);
    if (url.origin !== base.origin || url.username || url.password) throw new Error('Off-origin portal link blocked.');
    return url.href;
  }
  async function request(method, url, data, referer) {
    await sleep(Math.max(0, config.requestDelay - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    let response;
    try {
      response = await client.request({ method, url: safeUrl(url), data, headers: {
        ...(referer ? { Referer: referer } : {}),
        ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      } });
    } catch {
      throw new Error('Network, timeout, or redirect error. Progress saved; check access before resuming.');
    }
    if ([401, 403, 429].includes(response.status)) throw new Error(`Portal returned HTTP ${response.status}. Stopped; do not bypass access controls or throttling.`);
    if (response.status < 200 || response.status >= 300) throw new Error(`Portal returned HTTP ${response.status}. Stopped without retrying.`);
    const html = String(response.data);
    if (/captcha|g-recaptcha|h-captcha|too many requests|account.{0,20}locked/i.test(html)) throw new Error('Portal requires verification or has blocked access. Stopped without bypassing it.');
    return { html, url: response.request?.res?.responseUrl || url };
  }
  const login = await request('get', base.href);
  const $ = cheerio.load(login.html);
  const form = $('form').filter((_, el) => $(el).find('input[type="password"]').length > 0).first();
  if (!form.length) throw new Error('Login form not recognized. No credentials submitted.');
  const payload = {};
  let username = false, password = false;
  form.find('input').each((_, input) => {
    const name = $(input).attr('name'), type = ($(input).attr('type') || 'text').toLowerCase();
    if (!name || $(input).is(':disabled')) return;
    if (type === 'password') { payload[name] = roll; password = true; }
    else if (['text', 'email'].includes(type)) { payload[name] = roll; username = true; }
    else if (['hidden', 'submit'].includes(type)) payload[name] = $(input).attr('value') || '';
  });
  form.find('button[type="submit"][name]').each((_, el) => { payload[$(el).attr('name')] = $(el).attr('value') || ''; });
  if (!username || !password) throw new Error('Login fields not recognized. No credentials submitted.');
  // Matches the existing college login flow: roll number as username AND password.
  // There is no password guessing, fallback credential list, or automatic retry.
  let page = await request('post', safeUrl(form.attr('action') || login.url, login.url), new URLSearchParams(payload).toString(), login.url);
  for (let i = 0; i < 4; i++) {
    if (/\binvalid\s+details\b/i.test(page.html)) {
      const error = new Error('Portal returned Invalid Details.');
      error.code = 'INVALID_DETAILS';
      throw error;
    }
    if (/invalid\s*credentials|incorrect\s*(password|credentials)/i.test(page.html)) throw new Error('Login rejected. Stopped after one attempt; check with the college.');
    const redirect = page.html.match(/(?:document\.|window\.|top\.|self\.|parent\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i)
      || page.html.match(/location\.replace\(\s*["']([^"']+)["']/i)
      || page.html.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i);
    if (!redirect) break;
    page = await request('get', safeUrl(redirect[1], page.url), null, page.url);
  }
  if (/<input[^>]+type\s*=\s*["']password["']/i.test(page.html)) throw new Error('Portal still shows a login form. Stopped after one attempt.');
  const profile = await request('get', safeUrl('StudentInformationForStudent.php'), null, page.url);
  return parseProfile(profile.html, roll);
}

const csvCell = value => `"${String(value).replace(/^[=+@\t\r-]/, "'$&").replace(/"/g, '""')}"`;
async function writePrivate(file, content) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function main() {
  const config = options(process.argv.slice(2));
  if (config.help) {
    console.log('node scripts/export-alumni.js --rolls FILE [--dry-run] [--base-url URL] [--allow-http] [--output DIR] [--delay-ms 10000] [--request-delay-ms 2000]');
    return;
  }
  if (!config.rolls) throw new Error('Provide --rolls FILE. See scripts/ALUMNI-EXPORT.md.');
  const rolls = readRolls(await fs.readFile(config.rolls, 'utf8'));
  if (config.dryRun) { console.log(`Validated ${rolls.length} unique roll numbers. No network requests made.`); return; }
  await runExport(rolls, config);
}

async function runExport(rolls, config) {
  const output = path.resolve(config.output);
  if (output === path.resolve('public') || output.startsWith(path.resolve('public') + path.sep)) throw new Error('Do not store student exports in the public web directory.');
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const checkpoint = path.join(output, 'students.json');
  let rows = [];
  try {
    rows = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
    if (!Array.isArray(rows) || rows.some(row => FIELDS.some(field => typeof row[field] !== 'string'))) throw new Error('Invalid checkpoint.');
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read checkpoint; preserve it and choose a new --output directory.'); }
  const skippedFile = path.join(output, 'skipped-rolls.json');
  let skipped = [];
  try {
    skipped = JSON.parse(await fs.readFile(skippedFile, 'utf8'));
    if (!Array.isArray(skipped) || skipped.some(row => typeof row.roll_number !== 'string' || row.reason !== 'Invalid Details')) throw new Error('Invalid skip log.');
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read skipped-rolls.json; preserve it and choose a new --output directory.'); }
  const completed = new Set(rows.map(row => row.roll_number));
  const skippedRolls = new Set(skipped.map(row => row.roll_number));
  console.log(`${rolls.length} unique input entries; ${rolls.filter(roll => completed.has(roll)).length} already exported; ${rolls.filter(roll => skippedRolls.has(roll)).length} previously skipped. Sequential mode; no automatic retries.`);
  let stopping = false;
  const stop = () => { stopping = true; console.log('Stopping after the current student is saved.'); };
  process.once('SIGINT', stop);
  try {
  for (let index = 0; index < rolls.length; index++) {
    if (stopping) break;
    const roll = rolls[index];
    if (completed.has(roll) || skippedRolls.has(roll)) continue;
    console.log(`Processing input entry ${index + 1}/${rolls.length}…`);
    let row;
    try {
      row = await collectStudent(roll, config);
    } catch (error) {
      if (error.code !== 'INVALID_DETAILS') throw error;
      skipped.push({ roll_number: roll, reason: 'Invalid Details' });
      await writePrivate(skippedFile, JSON.stringify(skipped, null, 2));
      skippedRolls.add(roll);
      console.log(`Skipped input entry ${index + 1}: Invalid Details. Recorded in skipped-rolls.json.`);
      if (!stopping && index < rolls.length - 1) await sleep(config.delay);
      continue;
    }
    const missing = FIELDS.filter(field => !row[field]);
    if (missing.length) {
      await writePrivate(path.join(output, 'needs-review.json'), JSON.stringify({ ...row, missing_fields: missing }, null, 2));
      throw new Error(`Profile is missing ${missing.join(', ')}. Partial record saved to needs-review.json; stopped rather than inventing values. A college-approved profile page or parser adjustment may be needed.`);
    }
    rows.push(row);
    // JSON is the canonical checkpoint; CSV is rebuilt from it, also on resume.
    await writePrivate(checkpoint, JSON.stringify(rows, null, 2));
    await writePrivate(path.join(output, 'students.csv'), '\uFEFF' + [FIELDS, ...rows.map(row => FIELDS.map(field => row[field]))].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
    completed.add(roll);
    if (!stopping && index < rolls.length - 1) await sleep(config.delay);
  }
  await writePrivate(path.join(output, 'students.csv'), '\uFEFF' + [FIELDS, ...rows.map(row => FIELDS.map(field => row[field]))].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  console.log(`Saved ${rows.length} profiles to the private output directory. Keep exports out of Git and the public website.`);
  } finally {
    process.removeListener('SIGINT', stop);
  }
}

module.exports = { readRolls, parseProfile, collectStudent, options, runExport };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
