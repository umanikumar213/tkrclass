const fs = require('fs');

async function readMp4Box(handle, offset, end) {
  if (offset + 8 > end) return null;
  const header = Buffer.alloc(16);
  const { bytesRead } = await handle.read(header, 0, 16, offset);
  if (bytesRead < 8) return null;
  let size = header.readUInt32BE(0);
  const type = header.subarray(4, 8).toString('ascii');
  let headerSize = 8;
  if (size === 1) {
    if (bytesRead < 16) return null;
    const extended = header.readBigUInt64BE(8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(extended);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) return null;
  return { type, offset, size, headerSize, contentStart: offset + headerSize, end: offset + size };
}

async function mp4TrackIsVideo(handle, track, boxBudget) {
  let trackOffset = track.contentStart;
  while (trackOffset < track.end && boxBudget.count++ < 10_000) {
    const child = await readMp4Box(handle, trackOffset, track.end);
    if (!child) return false;
    if (child.type === 'mdia') {
      let mediaOffset = child.contentStart;
      while (mediaOffset < child.end && boxBudget.count++ < 10_000) {
        const mediaChild = await readMp4Box(handle, mediaOffset, child.end);
        if (!mediaChild) return false;
        if (mediaChild.type === 'hdlr' && mediaChild.contentStart + 12 <= mediaChild.end) {
          const payload = Buffer.alloc(12);
          const { bytesRead } = await handle.read(payload, 0, 12, mediaChild.contentStart);
          return bytesRead === 12 && payload.subarray(8, 12).toString('ascii') === 'vide';
        }
        mediaOffset = mediaChild.end;
      }
    }
    trackOffset = child.end;
  }
  return false;
}

async function validateMp4(file) {
  const invalid = () => {
    const error = new Error('Use a valid MP4 video.');
    error.code = 'INVALID_VIDEO';
    return error;
  };
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const stat = await handle.stat();
    let offset = 0, validBrand = false, hasVideoTrack = false;
    const boxBudget = { count: 0 };
    while (offset < stat.size && boxBudget.count++ < 10_000) {
      const box = await readMp4Box(handle, offset, stat.size);
      if (!box) throw invalid();
      if (box.type === 'ftyp') {
        const brandLength = Math.min(box.size - box.headerSize, 256);
        if (brandLength < 8) throw invalid();
        const brandsBuffer = Buffer.alloc(brandLength);
        const { bytesRead } = await handle.read(brandsBuffer, 0, brandLength, box.contentStart);
        if (bytesRead !== brandLength) throw invalid();
        const brands = [brandsBuffer.subarray(0, 4).toString('ascii')];
        for (let i = 8; i + 4 <= brandLength; i += 4) brands.push(brandsBuffer.subarray(i, i + 4).toString('ascii'));
        validBrand = brands.some(brand => /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV|F4V )$/.test(brand)) && !brands.includes('qt  ');
      } else if (box.type === 'moov') {
        let childOffset = box.contentStart;
        while (childOffset < box.end && boxBudget.count++ < 10_000) {
          const child = await readMp4Box(handle, childOffset, box.end);
          if (!child) throw invalid();
          if (child.type === 'trak' && await mp4TrackIsVideo(handle, child, boxBudget)) {
            hasVideoTrack = true;
            break;
          }
          childOffset = child.end;
        }
      }
      if (validBrand && hasVideoTrack) return;
      offset = box.end;
    }
    throw invalid();
  } catch (error) {
    if (error.code === 'INVALID_VIDEO') throw error;
    throw invalid();
  } finally { await handle.close(); }
}
module.exports = { validateMp4 };
