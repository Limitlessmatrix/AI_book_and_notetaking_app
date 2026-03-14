/**
 * generate-icon.js
 *
 * Creates a minimal valid ICO file (256×256 placeholder) in assets/icon.ico
 * so electron-builder can build the Windows installer without external tools.
 *
 * Run once:  node scripts/generate-icon.js
 *
 * For a real release you would replace assets/icon.ico with a proper
 * 256-colour icon (can be created with GIMP, IcoFX, or online converters).
 */

const fs   = require('fs');
const path = require('path');

// ── Build a minimal 1×1 pixel ICO as a placeholder ────────────────────────────
// Real ICO format:
//   6-byte header, 16-byte directory entry, 40-byte BITMAPINFOHEADER,
//   4 bytes RGBQUAD (palette), pixel data, mask data.
// We embed a 1×1 blue pixel at every standard size by repeating the same
// tiny bitmap (the OS scales it). This satisfies electron-builder's format check.

function makeIco() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];

  // Build each image as a DIB (BITMAPINFOHEADER + pixel data + mask)
  const images = sizes.map((sz) => {
    const rowBytes  = Math.ceil((sz * 24) / 32) * 4; // 24-bit, DWORD aligned
    const maskBytes = Math.ceil(sz / 32) * 4;        // 1-bit mask, DWORD aligned
    const pixelData = Buffer.alloc(rowBytes * sz, 0);
    const maskData  = Buffer.alloc(maskBytes * sz, 0);

    // Fill with a pleasant blue (R:37 G:99 B:235)
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const idx = y * rowBytes + x * 3;
        pixelData[idx]     = 0xeb; // B
        pixelData[idx + 1] = 0x63; // G
        pixelData[idx + 2] = 0x25; // R
      }
    }

    // BITMAPINFOHEADER (40 bytes)
    const bih = Buffer.alloc(40);
    bih.writeUInt32LE(40,              0);  // biSize
    bih.writeInt32LE(sz,               4);  // biWidth
    bih.writeInt32LE(sz * 2,           8);  // biHeight (×2 for XOR+AND masks)
    bih.writeUInt16LE(1,              12);  // biPlanes
    bih.writeUInt16LE(24,             14);  // biBitCount
    bih.writeUInt32LE(0,              16);  // biCompression = BI_RGB
    bih.writeUInt32LE(pixelData.length + maskData.length, 20);
    // remaining fields default to 0

    return Buffer.concat([bih, pixelData, maskData]);
  });

  // ICO header (6 bytes)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(images.length, 4);

  // Directory entries (16 bytes each)
  let offset = 6 + images.length * 16;
  const dirs = images.map((img, i) => {
    const sz  = sizes[i];
    const dir = Buffer.alloc(16);
    dir.writeUInt8(sz >= 256 ? 0 : sz, 0); // width  (0 = 256)
    dir.writeUInt8(sz >= 256 ? 0 : sz, 1); // height (0 = 256)
    dir.writeUInt8(0,   2); // colour count (0 = >8bpp)
    dir.writeUInt8(0,   3); // reserved
    dir.writeUInt16LE(1, 4); // planes
    dir.writeUInt16LE(24, 6); // bit count
    dir.writeUInt32LE(img.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += img.length;
    return dir;
  });

  return Buffer.concat([header, ...dirs, ...images]);
}

const outPath = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.writeFileSync(outPath, makeIco());
console.log(`✅  Icon written to ${outPath}`);
console.log('   Replace it with a proper .ico for a polished release.');
