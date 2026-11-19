const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runCountChecks() {
  let now = Date.now();
  const values = new Map();
  const events = [];
  class ClockDate extends Date { static now() { return now; } }
  const window = { dispatchEvent(event) { events.push(event); } };
  const localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const context = { window, localStorage, Date: ClockDate, CustomEvent: class {
    constructor(type, { detail }) { this.type = type; this.detail = detail; }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/spotlight-counts.js'), 'utf8'), context);
  const counts = window.spotlightCounts;
  const roll = '26K91A0101';
  assert.equal(counts.get(roll), null);
  counts.publish(roll.toLowerCase(), 2);
  assert.equal(counts.get(roll), 2);
  assert.equal(events[0].type, 'spotlight:like-count');
  counts.publish(roll, 1);
  assert.equal(counts.get(roll), 1);
  for (const invalid of [-1, 1.5, Infinity, NaN]) counts.publish(roll, invalid);
  assert.equal(counts.get(roll), 1);
  now += 60000;
  assert.equal(counts.get(roll), null, 'Overrides expire at the directory cache TTL');
  assert.equal(JSON.parse(values.get('spotlight-like-counts'))[roll], undefined);
  values.set('spotlight-like-counts', 'broken JSON');
  assert.equal(counts.get(roll), null);
  localStorage.getItem = () => { throw new Error('Storage blocked'); };
  localStorage.setItem = () => { throw new Error('Storage blocked'); };
  counts.publish(roll, 3);
  assert.equal(counts.get(roll), 3, 'Blocked storage cannot break a successful like response');
  now += 60001;
  assert.equal(counts.get(roll), null);
  console.log('PASS: authoritative count overrides expire after 60s and tolerate corrupt or blocked storage.');
}
module.exports = { runCountChecks };
