#!/usr/bin/env node

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3345;
const DEFAULT_TRANSCRIPT = 'mock realtime voice draft';
const DEFAULT_REFINED_TEXT = 'mock refined voice draft';

const options = parseArgs(process.argv.slice(2));
const host = options.host ?? process.env.XDT_MOBILE_E2E_VOICE_PROXY_HOST ?? DEFAULT_HOST;
const port = parsePort(options.port ?? process.env.XDT_MOBILE_E2E_VOICE_PROXY_PORT, DEFAULT_PORT);
const transcript = options.transcript ?? process.env.XDT_MOBILE_E2E_VOICE_TRANSCRIPT ?? DEFAULT_TRANSCRIPT;
const refinedText = options.refinedText ?? process.env.XDT_MOBILE_E2E_VOICE_REFINED_TEXT ?? DEFAULT_REFINED_TEXT;
const debug = process.env.XDT_MOBILE_E2E_DEBUG === '1';

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    void handleChatCompletion(req, res);
    return;
  }
  // Cindy 托管语音面(voice-server mock):手机托管路径先在这里换一次性票据,
  // 再按返回的 websocketUrl 连本 mock 的 realtime 端点;refine/refine-warmup
  // 复用同一台 mock。ticket/鉴权不校验——e2e 只验证客户端链路形状。
  if (req.method === 'POST' && url.pathname === '/api/voice/sessions') {
    void handleManagedSessionCreate(req, res, url);
    return;
  }
  const refineMatch = url.pathname.match(/^\/api\/voice\/sessions\/[^/]+\/refine$/);
  if (req.method === 'POST' && refineMatch) {
    void handleChatCompletion(req, res);
    return;
  }
  const warmupMatch = url.pathname.match(/^\/api\/voice\/sessions\/[^/]+\/refine-warmup$/);
  if (req.method === 'POST' && warmupMatch) {
    void readRequestBody(req).then(
      () => {
        res.writeHead(204).end();
      },
      (err) => writeInternalError(res, err),
    );
    return;
  }
  writeJson(res, 404, { error: 'not_found' });
});

// 托管 ASR 链头(volcengine)走原生协议,本 mock 不实现——upgrade 阶段直接
// destroy,让客户端按真实 fallback 逻辑切到 qwen realtime(mock 实现的协议)。
const MANAGED_ASR_WS_PATHS = {
  'litellm-volcengine-sauc-asr': '/volcengine/api/v3/sauc/bigmodel_async',
  'litellm-qwen3-asr-flash-realtime': '/dashscope/api-ws/v1/realtime',
  'litellm-gpt-realtime-whisper': '/openai/passthrough/v1/realtime',
};

async function handleManagedSessionCreate(req, res, url) {
  try {
    const body = await readJsonRequestBody(req);
    const asrProvider = typeof body?.asrProvider === 'string' ? body.asrProvider : '';
    const wsPath = MANAGED_ASR_WS_PATHS[asrProvider];
    if (!wsPath) {
      writeJson(res, 400, { error: { code: 'INVALID_PARAMS', message: `unsupported asrProvider: ${asrProvider}` } });
      return;
    }
    const wsHost = req.headers.host ?? `localhost:${port}`;
    writeJson(res, 201, {
      sessionId: `mock-session-${Date.now()}`,
      ticket: 'mock-one-shot-ticket',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      asr: {
        provider: asrProvider,
        websocketUrl: `ws://${wsHost}${wsPath}`,
        protocolProfile: asrProvider === 'litellm-volcengine-sauc-asr'
          ? 'volcengine-sauc-duration'
          : asrProvider === 'litellm-gpt-realtime-whisper'
            ? 'openai-transcription-manual'
            : 'qwen-asr-server-vad',
        sampleRate: 16_000,
      },
      refiner: body?.refinerProvider
        ? { enabled: true, provider: body.refinerProvider }
        : { enabled: false },
    });
    if (debug) console.error(`[mock-voice-proxy] managed session issued for ${asrProvider} (url=${url.pathname})`);
  } catch (err) {
    writeInternalError(res, err);
  }
}

function readJsonRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

const realtime = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (
    url.pathname !== '/openai/passthrough/v1/realtime'
    && url.pathname !== '/dashscope/api-ws/v1/realtime'
  ) {
    socket.destroy();
    return;
  }
  realtime.handleUpgrade(req, socket, head, (ws) => {
    realtime.emit('connection', ws, req);
  });
});

realtime.on('connection', (ws) => {
  let partialSent = false;
  let completed = false;
  const itemId = `mock-voice-${Date.now()}`;

  const send = (payload) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  const sendPartial = () => {
    if (partialSent || completed) return;
    partialSent = true;
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: itemId,
      delta: transcript,
    });
  };

  const sendCompleted = () => {
    if (completed) return;
    completed = true;
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript,
    });
  };

  ws.on('message', (raw) => {
    const event = parseJson(raw);
    if (!event || typeof event.type !== 'string') return;
    if (debug) console.error(`[mock-voice-proxy] realtime event type=${event.type}`);
    switch (event.type) {
      case 'session.update':
        send({ type: 'session.updated' });
        setTimeout(sendPartial, 80);
        break;
      case 'input_audio_buffer.commit':
        send({ type: 'input_audio_buffer.committed', item_id: itemId });
        setTimeout(sendCompleted, 40);
        break;
      case 'session.finish':
        sendCompleted();
        send({ type: 'session.finished' });
        break;
    }
  });
});

server.listen(port, host, () => {
  console.log(`mock-voice-proxy ready http://localhost:${port}`);
});

async function handleChatCompletion(req, res) {
  try {
    await readRequestBody(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const chunk of splitRefinedJson(refinedText)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      await sleep(40);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    writeInternalError(res, err);
  }
}

function splitRefinedJson(text) {
  const json = JSON.stringify({ text });
  const firstSplit = Math.max(1, Math.min(json.length - 1, Math.floor(json.length / 2)));
  return [json.slice(0, firstSplit), json.slice(firstSplit)];
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// 内部错误细节只进本地终端;HTTP 响应回笼统信息(CodeQL js/stack-trace-exposure)。
function writeInternalError(res, err) {
  console.error('[mock-voice-proxy] internal error:', err);
  writeJson(res, 500, { error: 'internal error' });
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function parseArgs(args) {
  const parsed = {
    host: undefined,
    port: undefined,
    refinedText: undefined,
    transcript: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--host') {
      parsed.host = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--port') {
      parsed.port = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--transcript') {
      parsed.transcript = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--refined-text') {
      parsed.refinedText = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
