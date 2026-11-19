const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// One release fingerprint keeps the page's CSS and scripts in sync. A new
// pathname bypasses stale browser/CDN entries, even if query strings are ignored.
const directory = path.join(__dirname, '..', 'public');
const files = ['spotlight.css', 'spotlight-ui.js', 'spotlight.js', 'spotlight-editor.js'];
const assets = new Map(files.map(file => [file, fs.readFileSync(path.join(directory, file))]));
const digest = createHash('sha256');
for (const [file, bytes] of assets) digest.update(file).update('\0').update(bytes);
const assetVersion = digest.digest('hex').slice(0, 20);
const templates = new Map(['spotlight.html', 'spotlight-profile.html', 'spotlight-admin.html'].map(file => [
  file,
  fs.readFileSync(path.join(directory, file), 'utf8').replace(
    /\b(src|href)="\/(spotlight(?:-ui|-editor)?\.(?:css|js))"/g,
    (match, attribute, asset) => assets.has(asset)
      ? `${attribute}="/spotlight-assets/${assetVersion}/${asset}"`
      : match,
  ),
]));

function renderSpotlightPage(file) {
  if (!templates.has(file)) throw new Error('Unknown Spotlight page');
  return templates.get(file);
}

function serveSpotlightAsset(req, res) {
  const bytes = assets.get(req.params.file);
  if (req.params.version !== assetVersion || !bytes) {
    return res.set('Cache-Control', 'no-store').sendStatus(404);
  }
  return res.type(req.params.file.endsWith('.css') ? 'css' : 'js')
    .set('Cache-Control', 'public, max-age=31536000, immutable')
    .send(bytes);
}

module.exports = { assetVersion, renderSpotlightPage, serveSpotlightAsset };
