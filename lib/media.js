const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { validateMp4 } = require('../media-validation');

const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const directories = new Set();
async function sweepStaleUploads() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const directory of directories) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
      const file = path.join(directory, entry.name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await fs.promises.unlink(file).catch(() => {});
    }));
  }
}
setInterval(() => {
  sweepStaleUploads().catch(() => console.error('Temporary upload cleanup failed.'));
}, 30 * 60 * 1000).unref();

function createUpload(board, imageField) {
  const directory = path.join(os.tmpdir(), `${board}-uploads`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  directories.add(directory);
  sweepStaleUploads().catch(() => console.error('Temporary upload cleanup failed.'));
  return multer({
    storage: multer.diskStorage({
      destination: directory,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname || '').toLowerCase()}`),
    }),
    limits: { fileSize: VIDEO_MAX_BYTES },
    fileFilter(req, file, cb) {
      const validImage = file.fieldname === imageField && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
      const validVideo = file.fieldname === 'video' && file.mimetype === 'video/mp4';
      cb(validImage || validVideo ? null : new Error('Use a JPG, PNG, WebP, or MP4 file.'), validImage || validVideo);
    },
  });
}
async function removeTemporaryUploads(req) {
  const files = Object.values(req.files || {}).flat();
  await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => {})));
}
async function compressImage(file) {
  if (!file) return { data: null, type: null };
  const input = file.buffer || await fs.promises.readFile(file.path);
  const image = sharp(input).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true });
  if (file.mimetype === 'image/png') return { data: await image.png({ quality: 75, compressionLevel: 8 }).toBuffer(), type: 'image/png' };
  if (file.mimetype === 'image/webp') return { data: await image.webp({ quality: 75 }).toBuffer(), type: 'image/webp' };
  return { data: await image.jpeg({ quality: 75, mozjpeg: true }).toBuffer(), type: 'image/jpeg' };
}
module.exports = { createUpload, compressImage, removeTemporaryUploads, validateMp4, IMAGE_MAX_BYTES, sweepStaleUploads };
