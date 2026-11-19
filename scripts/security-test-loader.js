// Load application modules with isolated credentials, transports, timers and a test-only Pool.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function createTestLoader({ pool, axios, directory, timers, logs = [] }) {
  const root = path.resolve(__dirname, '..');
  const cache = new Map();
  class NightDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-11-18T18:00:00Z'])); }
  }
  const env = {
    ADMIN_PASSWORD: 'test-only-admin-password',
    SESSION_SECRET: 'test-only-session-signing-secret',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHANNEL_ID: 'test-channel',
    ALLOWED_ORIGINS: 'https://allowed.example',
  };
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const originalRequire = createRequire(filename);
    function testRequire(name) {
      if (name === './db' || name === '../db') return pool;
      if (name === 'axios') return axios;
      if (name === 'axios-cookiejar-support') return { wrapper: client => client };
      if (name === 'os') return { tmpdir: () => directory };
      if (name.startsWith('.')) return load(require.resolve(path.resolve(path.dirname(filename), name)));
      return originalRequire(name);
    }
    testRequire.main = null;
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: testRequire, module, exports: module.exports, __dirname: path.dirname(filename),
      process: { env }, Buffer, URL, URLSearchParams, Date: NightDate,
      console: { log() {}, warn(...a) { logs.push(a.join(' ')); }, error(...a) { logs.push(a.join(' ')); } },
      setInterval(fn, delay) {
        const timer = setInterval(fn, delay);
        timers.push(timer);
        return timer;
      },
    }, { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    return module.exports;
  }
  return { load: name => load(path.resolve(root, name)), env, logs };
}
module.exports = { createTestLoader };
