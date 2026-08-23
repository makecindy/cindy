import { describe, expect, it } from 'vitest';

import {
  effectivePiWireProtocol,
  resolvePiModelRoute,
  resolvePiModelWireProtocol,
} from '../pi-catalog-marker.js';

describe('effectivePiWireProtocol', () => {
  it('keeps an omitted Pi protocol distinct from explicit Chat', () => {
    expect(effectivePiWireProtocol(undefined)).toBeUndefined();
    expect(effectivePiWireProtocol('openai-chat')).toBe('openai-chat');
  });

  it('preserves explicit non-default protocols', () => {
    expect(effectivePiWireProtocol('anthropic-messages')).toBe('anthropic-messages');
    expect(effectivePiWireProtocol('openai-responses')).toBe('openai-responses');
  });
});

describe('resolvePiModelRoute', () => {
  it('keeps a model endpoint paired with its effective protocol', () => {
    expect(
      resolvePiModelRoute(
        {
          piApi: 'anthropic-messages',
          route: {
            baseUrl: 'https://provider.example/anthropic',
            wireProtocol: 'anthropic-messages',
            requestPath: '/tenant/messages',
          },
        },
        { baseUrl: 'https://provider.example/v1', wireProtocol: 'openai-chat' },
      ),
    ).toEqual({
      baseUrl: 'https://provider.example/anthropic',
      wireProtocol: 'anthropic-messages',
      requestPath: '/tenant/messages',
    });
  });

  it.each([
    ['openai-completions', 'openai-chat'],
    ['openai-responses', 'openai-responses'],
  ] as const)(
    'ignores a stale model endpoint when %s selects another protocol',
    (piApi, wireProtocol) => {
      expect(
        resolvePiModelRoute(
          {
            piApi,
            route: {
              baseUrl: 'https://provider.example/anthropic',
              wireProtocol: 'anthropic-messages',
              requestPath: '/v1/messages',
            },
          },
          { baseUrl: 'https://provider.example/v1', wireProtocol: 'openai-chat' },
        ),
      ).toEqual({
        baseUrl: 'https://provider.example/v1',
        wireProtocol,
      });
    },
  );

  it('keeps a legacy route authoritative when no portable override was stored', () => {
    expect(
      resolvePiModelRoute(
        {
          route: {
            baseUrl: 'https://provider.example/anthropic',
            wireProtocol: 'anthropic-messages',
            requestPath: '/tenant/messages',
          },
        },
        { baseUrl: 'https://provider.example/v1', wireProtocol: 'openai-chat' },
      ),
    ).toEqual({
      baseUrl: 'https://provider.example/anthropic',
      wireProtocol: 'anthropic-messages',
      requestPath: '/tenant/messages',
    });
  });
});

describe('resolvePiModelWireProtocol', () => {
  it('prefers a portable model override over route and provider defaults', () => {
    expect(
      resolvePiModelWireProtocol(
        {
          piApi: 'anthropic-messages',
          route: { wireProtocol: 'openai-responses' },
        },
        'openai-chat',
      ),
    ).toBe('anthropic-messages');
    expect(resolvePiModelWireProtocol({ piApi: 'openai-completions' }, 'openai-responses')).toBe(
      'openai-chat',
    );
  });

  it('uses route then provider defaults and fails closed for native Google', () => {
    expect(
      resolvePiModelWireProtocol({ route: { wireProtocol: 'openai-responses' } }, 'openai-chat'),
    ).toBe('openai-responses');
    expect(resolvePiModelWireProtocol(undefined, 'openai-chat')).toBe('openai-chat');
    expect(resolvePiModelWireProtocol({ piApi: 'google-generative-ai' }, 'openai-chat')).toBeNull();
    expect(resolvePiModelWireProtocol(undefined, undefined)).toBeNull();
  });
});
