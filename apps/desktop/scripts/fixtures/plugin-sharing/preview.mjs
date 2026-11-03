// Build a local review canvas. No Electron, credentials, business API calls or browser launch loop.
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig.js';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '../../..');
const renderer = path.join(desktop, 'src/renderer');
const out = path.join(os.tmpdir(), 'cindy-plugin-sharing-web-preview');
await mkdir(out, { recursive: true });
const invisible = {
  '@/contexts/AuthContext': `export const useAuth=()=>({isAuthenticated:new URLSearchParams(location.search).get('account')!=='anonymous',dataOwnerGeneration:1,dataOwnerId:'preview-owner'});`,
  '@/features/cc-agent/GithubAccountCard': 'export const GithubAccountCard=()=>null;',
  '@/cindy-brain/CindyCapabilityPrefs': 'export const CindyCapabilityPrefs=()=>null;',
  '@/cindy-brain/PluginTaskPrefs': 'export const PluginTaskPrefs=()=>null;',
  '@/cindy-brain/GhostSettingsWebview': 'export const GhostSettingsWebview=()=>null;',
  './GhostLibrarySection': 'export const GhostLibrarySection=()=>null;',
};
const result = await build({ entryPoints: [path.join(here, 'app.tsx')], outdir: out, entryNames: 'client', bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', tsconfig: path.join(desktop, 'tsconfig.json'), loader: { '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl', '.woff2': 'file', '.woff': 'file' }, define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' }, plugins: [{ name: 'host-only-fixtures', setup(b) { b.onResolve({ filter: /.*/ }, (a) => invisible[a.path] ? { path: a.path, namespace: 'fixture' } : undefined); b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({ contents: invisible[a.path], loader: 'tsx' })); } }] });
const config = loadConfig(path.join(desktop, 'tailwind.config.ts'));
config.content = [path.join(renderer, '**/*.{ts,tsx,html}'), path.join(here, 'app.tsx')];
for (const file of result.outputFiles) {
  const bytes = file.path.endsWith('.css') ? (await postcss([tailwind(config)]).process(file.text, { from: file.path })).css : file.contents;
  await writeFile(file.path, bytes);
}
const client = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cindy 插件分享 · 客户端组件</title><link rel="stylesheet" href="/client.css"></head><body><div id="root"></div><script type="module" src="/client.js"></script></body></html>';
const shell = await readFile(path.join(here, 'index.html'), 'utf8');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4178');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/share/')) {
    // The canvas only reads its fixture and creates shares. Choose literal
    // targets so no request path, query or redirect can select another endpoint.
    const target = !url.search && req.method === 'GET' && url.pathname === '/share/fixture.json'
      ? 'http://127.0.0.1:4179/fixture.json'
      : !url.search && req.method === 'POST' && url.pathname === '/share/api/shares'
        ? 'http://127.0.0.1:4179/api/shares'
        : null;
    if (!target) { res.writeHead(404).end(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const headers = {};
      for (const key of ['content-type', 'authorization']) if (req.headers[key]) headers[key] = req.headers[key];
      const response = await fetch(target, { method: req.method, redirect: 'error', headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503).end('分享网页原型尚未启动'); }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/client') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(url.pathname === '/' ? shell : client); return; }
  const name = path.basename(url.pathname);
  try { const file = path.join(out, name); if (!(await stat(file)).isFile()) throw Error('Not a file'); res.setHeader('Content-Type', types[path.extname(name)] ?? 'application/octet-stream'); createReadStream(file).pipe(res); }
  catch { res.writeHead(404).end(); }
}).listen(4178, '127.0.0.1', () => process.stdout.write('客户端原型：http://127.0.0.1:4178\n'));
