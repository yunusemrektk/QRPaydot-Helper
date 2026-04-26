/**
 * Crops the whitespace from installer/app-icon.png, then generates:
 *   - installer/app-icon.png  (256x256, trimmed, transparent bg)
 *   - installer/QRPaydotHelper.ico (256, 48, 32, 16)
 *   - public/app-icon.png (32x32 for sidebar/favicon)
 */
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcPng = join(root, 'installer', 'app-icon.png');

async function run() {
  const trimmed = await sharp(srcPng)
    .trim()
    .png()
    .toBuffer();

  const sizes = [256, 48, 32, 16];
  const pngBuffers = [];

  for (const size of sizes) {
    const buf = await sharp(trimmed)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push({ size, buf });
  }

  const icon256 = pngBuffers.find(p => p.size === 256).buf;
  writeFileSync(join(root, 'installer', 'app-icon.png'), icon256);
  console.log('wrote installer/app-icon.png (256x256 trimmed)');

  const icon32 = pngBuffers.find(p => p.size === 32).buf;
  writeFileSync(join(root, 'public', 'app-icon.png'), icon32);
  console.log('wrote public/app-icon.png (32x32)');

  const icoBuf = await pngToIco(pngBuffers.map(p => p.buf));
  writeFileSync(join(root, 'installer', 'QRPaydotHelper.ico'), icoBuf);
  console.log('wrote installer/QRPaydotHelper.ico (256,48,32,16)');
}

run().catch(err => { console.error(err); process.exit(1); });
