#!/usr/bin/env node
/**
 * custom-im-client — 自定义 IM 渠道的终端客户端。
 *
 * 用途: 在本机手动跑通「发消息 → 伙伴回复」，不需要另写脚本。
 *
 *   1. 读 Cindy 写在 userData 里的发现文件(默认按区域+沙箱名推导, 也可用 --discovery 指定)
 *   2. 从安全存储读取连接 token(或用 --token 传入)
 *   3. 起一个本地 HTTP 回调服务器, 把 reply 打印到终端
 *   4. 交互式读入消息, 走 Unix socket 发给 Cindy
 *
 * 用法:
 *   node tools/custom-im-client.mjs --connection <id> [--sandbox <name>] [--region global]
 *   node tools/custom-im-client.mjs --socket <path> --token <token> --connection <id>
 *
 * token 来源: 设置页添加渠道时只显示一次; 丢失就用「重置 token」重新生成。
 */

import { createServer } from 'node:http';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const DEFAULT_ROOT =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? os.homedir())
      : path.join(os.homedir(), '.config');

const region = arg('region', 'global');
const sandbox = arg('sandbox', '');
const discoveryDir =
  arg('discovery') ??
  (sandbox
    ? path.join(DEFAULT_ROOT, `CindyGlobal-dev2-${sandbox}`, 'owners')
    : path.join(DEFAULT_ROOT, region === 'cn' ? 'Cindy' : 'CindyGlobal', 'owners'));

function findEndpointFile(dir) {
  if (!fs.existsSync(dir)) return null;
  if (fs.statSync(dir).isFile()) return dir;
  for (const entry of fs.readdirSync(dir)) {
    const candidate = path.join(dir, entry, 'im-custom', 'endpoint.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const endpointFile = findEndpointFile(discoveryDir);
if (!endpointFile && !arg('socket')) {
  console.error(`找不到端点文件: ${discoveryDir}(先在 Cindy 里添加一条自定义渠道)`);
  process.exit(1);
}
const { socketPath: discoveredSocketPath } = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
// 显式 --socket 优先: 跨账号或手工转发时不必依赖发现文件。
const socketPath = arg('socket') ?? discoveredSocketPath;
const connectionId = arg('connection');
const tokenFile = arg('token-file');
const token = arg('token') ?? (tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : null);
if (!connectionId) {
  console.error('缺少 --connection <id>(设置页里入站地址中的那段 id)');
  process.exit(1);
}
if (!token) {
  console.error('缺少 --token(设置页添加渠道时显示一次; 丢失请点「重置 token」)');
  process.exit(1);
}

const conversationId = arg('conversation', 'cli-1');

/** 回调服务器: 只认 127.0.0.1, 收到一条就打印。 */
const callbackServer = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.statusCode = 401;
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      printReply(body);
      res.statusCode = 200;
      res.end('ok');
    } catch {
      res.statusCode = 400;
      res.end();
    }
  });
});

// 回调端口: 默认由系统分配; 传 --callback-port 可固定(伙伴页里就能写死同一个地址)。
const callbackPortArg = Number(arg('callback-port', '0'));
await new Promise((resolve) =>
  callbackServer.listen(Number.isFinite(callbackPortArg) ? callbackPortArg : 0, '127.0.0.1', resolve),
);
const callbackPort = callbackServer.address().port;
const callbackUrl = `http://127.0.0.1:${callbackPort}/reply`;

function printReply(body) {
  const label = body.terminal === 'done' ? '伙伴' : `伙伴(${body.terminal})`;
  process.stdout.write(`\n${label}: ${body.text ?? ''}\n`);
  for (const file of body.attachments ?? []) {
    process.stdout.write(`  附件: ${file.absPath}\n`);
  }
  if (body.errorCode) process.stdout.write(`  errorCode: ${body.errorCode}\n`);
  process.stdout.write('你: ');
}

/** 走 Unix socket 发一条入站消息。 */
function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const table = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
  };
  return table[ext] ?? 'application/octet-stream';
}

function send(text, attachments = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      conversationId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      callbackUrl,
    });
    const req = http.request(
      {
        socketPath,
        path: `/im/custom/${encodeURIComponent(connectionId)}/inbound`,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode === 202) resolve();
          else reject(new Error(`inbound ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

console.log(`端点: ${socketPath}`);
console.log(`连接: ${connectionId}   会话: ${conversationId}`);
console.log(`回调: ${callbackUrl}`);
console.log('输入消息回车发送, /exit 退出。\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你: ' });
rl.prompt();
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === '/exit') {
    rl.close();
    return;
  }
  // /file <absPath> [说明] 与 /image <absPath> [说明]: 带附件发一条消息。
  const attachMatch = /^\/(file|image)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  let body = text;
  let attachments = [];
  if (attachMatch) {
    const [, kind, filePath, caption] = attachMatch;
    if (!path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
      process.stdout.write(`附件不存在或不是绝对路径: ${filePath}\n`);
      return rl.prompt();
    }
    if (!fs.statSync(filePath).isFile()) {
      process.stdout.write(`不是一个文件: ${filePath}\n`);
      return rl.prompt();
    }
    body = caption?.trim() || (kind === 'image' ? '请看一下这张图片。' : '请处理这个文件。');
    attachments = [{ absPath: filePath, name: path.basename(filePath), mimeType: mimeOf(filePath) }];
  }
  send(body, attachments)
    .then(() => process.stdout.write('(已发送, 等待回复…)\n'))
    .catch((err) => process.stdout.write(`发送失败: ${err.message}\n`))
    .finally(() => rl.prompt());
});
rl.on('close', () => {
  callbackServer.close();
  process.exit(0);
});
