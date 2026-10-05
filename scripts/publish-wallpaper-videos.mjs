#!/usr/bin/env node
// Verify bundled assets; only opt-in CDN entries are published as reviewed bytes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOSSClient, resolveOssConfig, uploadToOSS } from './shared/oss.mjs';

const args = process.argv.slice(2);
const region = args.find(arg => arg.startsWith('--region='))?.slice(9) ?? 'global';
const directory = args.find(arg => arg.startsWith('--directory='))?.slice(12);
const verifyOnly = args.includes('--verify-only');
if (!['global', 'cn'].includes(region)) {
  throw new Error('Usage: node [--env-file=...] scripts/publish-wallpaper-videos.mjs --directory=<videos> --region=global|cn [--verify-only]');
}
const manifest = JSON.parse(await fs.readFile(new URL('../apps/desktop/src/shared/wallpaper-video-manifest.json', import.meta.url), 'utf8'));
const assets = [];
for (const [id, asset] of Object.entries(manifest)) {
  if (!['bundled', 'cdn'].includes(asset.delivery)) throw new Error('Unknown wallpaper delivery: ' + id);
  if (asset.delivery === 'cdn' && !directory) throw new Error('CDN entries require --directory=<videos>');
  const file = asset.delivery === 'bundled'
    ? fileURLToPath(new URL('../apps/desktop/src/renderer/assets/wallpapers/' + id + '.mp4', import.meta.url))
    : path.resolve(directory, id + '-hd.mp4');
  const bytes = await fs.readFile(file);
  if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error('Video differs from reviewed manifest: ' + id);
  }
  if (asset.delivery === 'cdn') assets.push({ file, ...asset });
  console.log(id + ': ' + asset.width + 'x' + asset.height + ', ' + asset.bytes + ' bytes');
}
console.log('CDN upload total: ' + assets.reduce((sum, asset) => sum + asset.bytes, 0) + ' bytes');
if (!verifyOnly && assets.length > 0) {
  // Missing publication configuration must never redirect to another region.
  const config = resolveOssConfig(region);
  const client = createOSSClient(region);
  for (const asset of assets) {
    const relative = 'wallpapers/' + asset.sha256 + '.mp4';
    await uploadToOSS(client, config.prefix.replace(/\/+$/, '') + '/' + relative, asset.file, {
      headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
    const response = await fetch(config.cdnBase + '/' + relative, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error('Published CDN resource is not readable: ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new Error('CDN resource integrity mismatch');
    console.log('Verified ' + relative);
  }
}
