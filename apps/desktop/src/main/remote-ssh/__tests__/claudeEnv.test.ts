/**
 * Tests for getRemoteClaudeEnv — the curated env subset ferried to remote
 * `claude --print` runs.
 *
 * Why these tests matter:
 *   The endpoint pairs with the gateway key (model-access issued; empty =
 *   credentials not synced yet / legacy manual key). If an empty
 *   ANTHROPIC_BASE_URL ever ships to the remote, the CLI falls back to
 *   api.anthropic.com and sends the XD gateway key there — a misleading 401
 *   completely detached from the real cause. These tests pin the contract:
 *   missing key OR missing endpoint → null (caller surfaces the "connect XD
 *   Gateway in xdt-maker first" error), never a half-configured env.
 */

import { describe, expect, it, vi } from 'vitest';

import { TEST_XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

const mockState = vi.hoisted(() => ({
  apiKey: null as string | null,
  endpoint: '',
}));

vi.mock('../../maker-host/auth-adapters.js', () => ({
  readClaudeApiKey: () => mockState.apiKey,
}));

vi.mock('../../maker-host/runtime-configs.js', () => ({
  claudeUpstreamEndpoint: () => mockState.endpoint,
}));

import { getRemoteClaudeEnv } from '../claude-env.js';

describe('getRemoteClaudeEnv', () => {
  it('returns null when no gateway key is configured', () => {
    mockState.apiKey = null;
    mockState.endpoint = TEST_XD_GATEWAY_BASE_URL;
    expect(getRemoteClaudeEnv()).toBeNull();
  });

  it('returns null when the gateway endpoint is empty (credentials not synced)', () => {
    // 回归:key 在、endpoint 空(model-access 未同步 / 存量手填 key)时绝不能
    // 组出 ANTHROPIC_BASE_URL 为空的 env —— 远端 CLI 会回落 api.anthropic.com
    // 并把网关 key 发过去,得到与真实原因无关的 401。
    mockState.apiKey = 'sk-xd-gateway-key';
    mockState.endpoint = '';
    expect(getRemoteClaudeEnv()).toBeNull();
    mockState.endpoint = '   ';
    expect(getRemoteClaudeEnv()).toBeNull();
  });

  it('returns key + endpoint + behaviour flags when both are present', () => {
    mockState.apiKey = 'sk-xd-gateway-key';
    mockState.endpoint = TEST_XD_GATEWAY_BASE_URL;
    const env = getRemoteClaudeEnv();
    expect(env).not.toBeNull();
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-xd-gateway-key',
      ANTHROPIC_BASE_URL: TEST_XD_GATEWAY_BASE_URL,
      ENABLE_TOOL_SEARCH: 'auto',
      DISABLE_TELEMETRY: '1',
    });
  });
});
