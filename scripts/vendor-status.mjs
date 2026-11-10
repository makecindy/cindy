#!/usr/bin/env node
// Read-only report: each bundled third-party runtime, where it is pinned, and how far
// the pin is behind upstream. Never edits pins (see environment-setup.md 不变量).
// Usage: node scripts/vendor-status.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

async function getJson(url) {
  const headers = { accept: 'application/json', 'user-agent': 'cindy-vendor-status' };
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function npmLatest(name) {
  const doc = await getJson(`https://registry.npmjs.org/${name}`);
  const latest = doc['dist-tags'].latest;
  return { latest, publishedAt: doc.time[latest], distTags: doc['dist-tags'], time: doc.time };
}

async function githubLatest(repo, stripPrefix) {
  const rel = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  return { latest: rel.tag_name.replace(stripPrefix, ''), publishedAt: rel.published_at };
}

function releasesBehind(time, pinned, latest) {
  if (!time) return null;
  const versions = Object.keys(time).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const after = versions.filter((v) => time[v] > (time[pinned] ?? '') && time[v] <= time[latest]);
  return after.length;
}

const sdkPins = ['packages/maker-core/package.json', 'packages/maker-cc-manager/package.json']
  .map((rel) => ({ rel, version: readJson(rel).dependencies['@anthropic-ai/claude-agent-sdk'] }));

const components = [
  {
    name: 'Claude Code CLI (native binary)',
    pin: 'tools/claude/latest.json',
    pinned: readJson('tools/claude/latest.json').version,
    update: 'pnpm update:claude <version>',
    upstream: () => npmLatest('@anthropic-ai/claude-code'),
  },
  {
    name: 'Claude Agent SDK (JS)',
    pin: sdkPins.map((p) => `${p.rel}=${p.version}`).join(', '),
    pinned: sdkPins[0].version,
    update: 'edit both package.json pins + pnpm install',
    upstream: () => npmLatest('@anthropic-ai/claude-agent-sdk'),
  },
  {
    name: 'Codex package (macOS/Windows/Linux runtime)',
    pin: 'tools/codex-package/latest.json',
    pinned: readJson('tools/codex-package/latest.json').version,
    update: 'pnpm update:codex-package',
    upstream: () => githubLatest('openai/codex', /^rust-v/),
  },
  {
    name: 'Codex CLI (Linux fallback / CDN release)',
    pin: 'tools/codex/latest.json',
    pinned: readJson('tools/codex/latest.json').version,
    update: 'pnpm update:codex',
    upstream: () => githubLatest('openai/codex', /^rust-v/),
  },
  {
    name: 'Pi',
    pin: 'tools/pi/latest.json',
    pinned: readJson('tools/pi/latest.json').version,
    update: 'pnpm update:pi',
    upstream: () => githubLatest('earendil-works/pi', /^v/),
  },
  {
    name: 'ripgrep (in installer)',
    pin: 'tools/ripgrep/latest.json',
    pinned: readJson('tools/ripgrep/latest.json').version,
    update: 'pnpm update:ripgrep',
    upstream: () => githubLatest('BurntSushi/ripgrep', /^/),
  },
  {
    name: 'Model catalog (offline copy)',
    pin: 'packages/model-providers/catalog/model-registry.json',
    pinned: readJson('packages/model-providers/catalog/model-registry.json').updatedAt,
    update: 'node packages/model-providers/scripts/sync-registry.mjs <Server providers.json>',
    upstream: null, // Server-owned; no public upstream to compare against.
  },
];

const rows = await Promise.all(components.map(async (c) => {
  const row = { name: c.name, pin: c.pin, pinned: c.pinned, update: c.update };
  if (!c.upstream) return { ...row, latest: '(Server)', status: 'manual sync' };
  try {
    const up = await c.upstream();
    const behind = up.time ? releasesBehind(up.time, c.pinned, up.latest) : null;
    return {
      ...row,
      latest: up.latest,
      publishedAt: up.publishedAt?.slice(0, 10),
      ...(up.distTags ? { distTags: up.distTags } : {}),
      behind,
      status: up.latest === c.pinned ? 'current' : `behind${behind ? ` (${behind} releases)` : ''}`,
    };
  } catch (error) {
    return { ...row, latest: '?', status: `lookup failed: ${error.message}` };
  }
}));

// The SDK and the CLI it drives ship in lockstep (sdk 0.3.N declares claudeCodeVersion 2.1.N).
let coupling = null;
try {
  const sdk = await getJson(`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/${sdkPins[0].version}`);
  coupling = { sdk: sdkPins[0].version, sdkBuiltFor: sdk.claudeCodeVersion, cliPinned: components[0].pinned };
} catch { /* reported as null */ }

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, coupling }, null, 2));
} else {
  for (const r of rows) {
    console.log(`${r.status === 'current' ? '✓' : '•'} ${r.name}`);
    console.log(`    pinned ${r.pinned}  latest ${r.latest}${r.publishedAt ? ` (${r.publishedAt})` : ''}  → ${r.status}`);
    console.log(`    pin: ${r.pin}`);
    console.log(`    update: ${r.update}`);
  }
  if (coupling) {
    const ok = coupling.sdkBuiltFor === coupling.cliPinned;
    console.log(`${ok ? '✓' : '•'} Agent SDK ${coupling.sdk} was built for Claude Code ${coupling.sdkBuiltFor}; pinned CLI is ${coupling.cliPinned}`);
  }
}
