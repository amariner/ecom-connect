import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

// Reuse Astro's installed image encoder. No API credentials or generation calls.
const require = createRequire(import.meta.resolve('astro/package.json'));
const sharp = require('sharp');
const manifest = process.argv[2];
if (!manifest) throw new Error('Usage: node scripts/prepare-generated-images.mjs <manifest.json>');
const items = JSON.parse(readFileSync(manifest, 'utf8'));
for (const item of items) {
  if (!/^[a-z0-9-]+$/.test(item.slug) || typeof item.path !== 'string') throw new Error('Invalid asset manifest');
  const hero = item.slug.startsWith('hero-');
  const target = `public/images/${hero ? 'heroes' : 'products/generated'}/${item.slug}.webp`;
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync('tmp/imagegen/originals', { recursive: true });
  copyFileSync(item.path, `tmp/imagegen/originals/${item.slug}.png`);
  await sharp(item.path).resize({ width: hero ? 1536 : 900, withoutEnlargement: true }).webp({ quality: 85 }).toFile(target);
  console.log(target);
}
