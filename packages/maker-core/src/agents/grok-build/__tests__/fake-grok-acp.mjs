#!/usr/bin/env node
import readline from 'node:readline';

const failInit = process.env.FAKE_GROK_FAIL_INIT === '1';
const failPrompt = process.env.FAKE_GROK_FAIL_PROMPT === '1';
const updateBeforeError = process.env.FAKE_GROK_UPDATE_BEFORE_ERROR === '1';
const promptDelayMs = Number(process.env.FAKE_GROK_PROMPT_DELAY_MS ?? '0');

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    if (failInit) {
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'initialize failed' } });
      return;
    }
    reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [] } });
    return;
  }
  if (msg.method === 'session/new') {
    reply({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId ?? 'sess-1';
    if (failPrompt && !updateBeforeError) {
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'prompt rejected' } });
      return;
    }
    reply({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      },
    });
    if (failPrompt && updateBeforeError) {
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'late failure' } });
      return;
    }
    const finish = () => {
      reply({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    };
    if (promptDelayMs > 0) setTimeout(finish, promptDelayMs);
    else finish();
  }
});
