// Regenerate the phone's artwork with the desktop's real renderer. Run on macOS:
// node apps/mobile/scripts/export-agent-activity-artwork.mjs
// Commit generated assets; EAS builds must not need a macOS GUI to render them.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.resolve(mobile, '../desktop/native/agent-island');
const helperSource = path.join(desktop, 'macos-agent-island-helper.swift');
const widgetSource = path.join(desktop, 'live-activity/CindyAgentActivityWidget.swift');
const palette = fs.readFileSync(widgetSource, 'utf8');
// Mobile uses the owner's selected Cindy character from the desktop catalog.
const skin = 'cindy';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = Object.fromEntries([helperSource, widgetSource,
  ...fs.readdirSync(path.join(desktop, 'mascots')).sort().map(file => path.join(desktop, 'mascots', file)),
].map(file => [path.relative(mobile, file).split(path.sep).join('/'), hash(fs.readFileSync(file))]));
const output = path.join(mobile, 'plugins/usage-widgets');
const manifestPath = path.join(output, 'agent-activity-artwork.json');
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.defaultMascot !== skin
    || JSON.stringify(manifest.sources) !== JSON.stringify(sourceHashes)
    || Object.entries(manifest.files).some(([file, digest]) => hash(fs.readFileSync(path.join(output, file))) !== digest)) {
    throw new Error('Desktop artwork changed. Run export-agent-activity-artwork.mjs on macOS and commit the regenerated assets.');
  }
  console.log(`Mobile artwork matches the desktop renderer (${skin}).`);
  process.exit(0);
}
if (process.platform !== 'darwin') throw new Error('Export requires macOS; use --check to verify existing assets elsewhere.');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-agent-artwork-'));
const files = {};
const write = (relative, bytes) => {
  const target = path.join(output, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  files[relative] = hash(bytes);
};
const json = value => `${JSON.stringify(value, null, 2)}\n`;
try {
  const helper = path.join(work, 'exporter');
  const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('xcrun', ['swiftc', helperSource, '-sdk', sdk, '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, '-o', helper], { stdio: 'inherit' });
  execFileSync(helper, ['--export-mascots', work], {
    stdio: 'inherit', env: { ...process.env, XDT_AGENT_ISLAND_ASSET_DIR: desktop },
  });
  for (const status of ['running', 'attention', 'completed']) {
    const name = `agent-island-${status}`;
    const image = `Assets.xcassets/${name}.imageset`;
    write(`${image}/${name}.png`, fs.readFileSync(path.join(work, `${skin}-${status}.png`)));
    write(`${image}/Contents.json`, json({ images: [{ filename: `${name}.png`, idiom: 'universal' }], info: { author: 'xcode', version: 1 } }));
    const match = palette.match(new RegExp(`static let ${status} = Color\\(red: ([\\d.]+), green: ([\\d.]+), blue: ([\\d.]+)\\)`));
    if (!match) throw new Error(`Desktop ${status} palette declaration changed; update the exporter.`);
    write(`Assets.xcassets/${name}.colorset/Contents.json`, json({ colors: [{ idiom: 'universal', color: {
      'color-space': 'srgb', components: { red: match[1], green: match[2], blue: match[3], alpha: '1.0' },
    } }], info: { author: 'xcode', version: 1 } }));
  }
  fs.writeFileSync(manifestPath, json({ defaultMascot: skin, sources: sourceHashes, files }));
  console.log(`Exported desktop ${skin} artwork and status colors for iPhone.`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
