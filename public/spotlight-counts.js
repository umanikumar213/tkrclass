(() => {
  'use strict';

  const storageKey = 'spotlight-like-counts';
  const maxAge = 60000;
  const memory = new Map();
  const normalizeRoll = (roll) => {
    const value = String(roll || '').trim().toUpperCase();
    return /^[A-Z0-9]{8,12}$/.test(value) ? value : '';
  };
  const readAll = () => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const writeAll = (value) => {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Cross-page refresh remains optional if storage is blocked. */ }
  };
  const get = (roll) => {
    const key = normalizeRoll(roll);
    if (!key) return null;
    const now = Date.now();
    const all = readAll();
    const storedEntry = all[key];
    const memoryEntry = memory.get(key);
    const entry = memoryEntry && (!storedEntry || Number(memoryEntry.at) > Number(storedEntry.at)) ? memoryEntry : storedEntry;
    if (!entry || !Number.isFinite(entry.at) || now - entry.at >= maxAge || now < entry.at
      || !Number.isSafeInteger(entry.count) || entry.count < 0) {
      if (all[key]) {
        delete all[key];
        writeAll(all);
      }
      memory.delete(key);
      return null;
    }
    return entry.count;
  };
  const publish = (roll, count) => {
    const key = normalizeRoll(roll);
    const value = Number(count);
    if (!key || !Number.isSafeInteger(value) || value < 0) return;
    const all = readAll();
    const now = Date.now();
    Object.keys(all).forEach((item) => {
      if (!all[item] || !Number.isFinite(Number(all[item].at)) || now - Number(all[item].at) > maxAge) delete all[item];
    });
    const entry = { count: value, at: now };
    all[key] = entry;
    memory.set(key, entry);
    writeAll(all);
    window.dispatchEvent(new CustomEvent('spotlight:like-count', { detail: { roll: key, count: value, at: now } }));
  };
  window.spotlightCounts = { get, publish };
})();
