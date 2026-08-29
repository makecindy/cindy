import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPiProxySessionProvider,
  registerPiProxySession,
  resetPiProxySessionsForTest,
} from '../pi-proxy-session-auth.js';
import { createPiResponsesVerbosityTransform } from '../pi-responses-verbosity.js';

const CTX = {
  reqId: 1,
  method: 'POST',
  url: '/v1/responses',
  headers: {
    'x-cindy-pi-session-id': 'session-1',
    'x-cindy-pi-session-token': 'token-1',
  },
};

afterEach(() => {
  resetPiProxySessionsForTest();
});

describe('Pi Responses verbosity transform', () => {
  it('adds low for a Cindy Codex GPT-5 gateway request', () => {
    const resolveProvider = vi.fn(() => 'xd');
    const transform = createPiResponsesVerbosityTransform(resolveProvider);

    expect(transform({ model: 'codex/gpt-5.6-sol', input: [] }, CTX)).toEqual({
      model: 'codex/gpt-5.6-sol',
      input: [],
      text: { verbosity: 'low' },
    });
    expect(resolveProvider).toHaveBeenCalledWith('session-1', 'token-1');
  });

  it('preserves an explicit verbosity and other text options', () => {
    const transform = createPiResponsesVerbosityTransform(() => 'xd');
    const body = {
      model: 'codex/gpt-5.6-sol',
      text: { verbosity: 'high', format: { type: 'text' } },
    };

    expect(transform(body, CTX)).toBeNull();
  });

  it.each([
    ['non-Pi request', { ...CTX, headers: {} }, { model: 'codex/gpt-5.6-sol' }],
    ['non-Responses path', { ...CTX, url: '/v1/messages' }, { model: 'codex/gpt-5.6-sol' }],
    ['third-party provider', CTX, { model: 'codex/gpt-5.6-sol' }],
    ['non-Codex model', CTX, { model: 'gpt-5.6-sol' }],
    ['non-GPT-5 model', CTX, { model: 'codex/o4-mini' }],
  ])('does not modify a %s', (_label, ctx, body) => {
    const transform = createPiResponsesVerbosityTransform(() =>
      _label === 'third-party provider' ? 'custom-provider' : 'xd',
    );
    expect(transform(body, ctx)).toBeNull();
  });

  it('uses the provider frozen onto an authenticated subagent route', () => {
    registerPiProxySession('session-1', 'subagent-token', () => 'xd', {
      scope: 'subagent-route',
    });
    const transform = createPiResponsesVerbosityTransform(getPiProxySessionProvider);

    expect(transform({ model: 'codex/gpt-5.6-sol' }, {
      ...CTX,
      headers: {
        'x-cindy-pi-session-id': 'session-1',
        'x-cindy-pi-session-token': 'subagent-token',
      },
    })).toEqual({
      model: 'codex/gpt-5.6-sol',
      text: { verbosity: 'low' },
    });
  });

  it('keeps existing text options when adding the default', () => {
    const transform = createPiResponsesVerbosityTransform(() => null);
    expect(transform({
      model: 'codex/gpt-5.6-terra',
      text: { format: { type: 'text' } },
    }, CTX)).toEqual({
      model: 'codex/gpt-5.6-terra',
      text: { format: { type: 'text' }, verbosity: 'low' },
    });
  });

  it('serializes low onto the request that reaches the Gateway', async () => {
    let resolveBody!: (body: Record<string, unknown>) => void;
    const receivedBody = new Promise<Record<string, unknown>>((resolve) => {
      resolveBody = resolve;
    });
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as AddressInfo).port;
    const proxy = await createAnthropicCompatProxy({
      upstream: `http://127.0.0.1:${port}`,
      transformRequest: [createPiResponsesVerbosityTransform(() => 'xd')],
    });

    try {
      const response = await fetch(`${proxy.url}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cindy-pi-session-id': 'session-1',
          'x-cindy-pi-session-token': 'token-1',
        },
        body: JSON.stringify({ model: 'codex/gpt-5.6-sol', input: [], stream: true }),
      });
      await response.text();
      expect(response.status).toBe(200);
      await expect(receivedBody).resolves.toMatchObject({
        model: 'codex/gpt-5.6-sol',
        text: { verbosity: 'low' },
      });
    } finally {
      await proxy.dispose();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
