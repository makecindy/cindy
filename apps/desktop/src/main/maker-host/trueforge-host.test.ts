import { describe, expect, it } from 'vitest';

import { readTrueForgeHostConfig, TRUEFORGE_ENV } from './trueforge-host';

function env(values: Partial<Record<(typeof TRUEFORGE_ENV)[keyof typeof TRUEFORGE_ENV], string>>) {
  return values as NodeJS.ProcessEnv;
}

describe('readTrueForgeHostConfig', () => {
  it('is opt-in and requires both endpoint and model', () => {
    expect(readTrueForgeHostConfig(env({}))).toBeNull();
    expect(() =>
      readTrueForgeHostConfig(
        env({
          [TRUEFORGE_ENV.baseUrl]: 'http://127.0.0.1:8787',
        }),
      ),
    ).toThrow(/configured together/);
  });

  it('accepts explicit loopback HTTP and keeps the token in main-process config', () => {
    const config = readTrueForgeHostConfig(
      env({
        [TRUEFORGE_ENV.baseUrl]: 'http://localhost:8787/',
        [TRUEFORGE_ENV.model]: 'openai/gpt-5',
        [TRUEFORGE_ENV.displayName]: 'Team model',
        [TRUEFORGE_ENV.contextWindow]: '200000',
        [TRUEFORGE_ENV.idToken]: 'secret-token',
      }),
    );
    expect(config).toEqual({
      baseUrl: 'http://localhost:8787',
      model: 'openai/gpt-5',
      displayName: 'Team model',
      contextWindow: 200_000,
      idToken: 'secret-token',
    });
  });

  it.each([
    'http://trueforge.example.com',
    'https://user:pass@trueforge.example.com',
    'https://trueforge.example.com/api/v1',
    'https://trueforge.example.com?token=secret',
  ])('rejects unsafe or non-origin endpoint %s', (baseUrl) => {
    expect(() =>
      readTrueForgeHostConfig(
        env({
          [TRUEFORGE_ENV.baseUrl]: baseUrl,
          [TRUEFORGE_ENV.model]: 'openai/gpt-5',
        }),
      ),
    ).toThrow();
  });

  it('validates model and context window without echoing the token', () => {
    const unsafe = env({
      [TRUEFORGE_ENV.baseUrl]: 'https://trueforge.example.com',
      [TRUEFORGE_ENV.model]: 'invalid',
      [TRUEFORGE_ENV.idToken]: 'do-not-log-me',
    });
    let message = '';
    try {
      readTrueForgeHostConfig(unsafe);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('do-not-log-me');
    expect(() =>
      readTrueForgeHostConfig(
        env({
          [TRUEFORGE_ENV.baseUrl]: 'https://trueforge.example.com',
          [TRUEFORGE_ENV.model]: 'openai/gpt-5',
          [TRUEFORGE_ENV.contextWindow]: '0',
        }),
      ),
    ).toThrow(/positive integer/);
  });
});
