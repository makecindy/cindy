import { describe, expect, it } from 'vitest';

import {
  OLLAMA_ANTHROPIC_BASE_URL,
  OLLAMA_OPENAI_BASE_URL,
} from '../../../shared/localModelRuntime.js';
import { migrateManagedOllamaProvider } from '../managedOllamaProvider.js';

describe('migrateManagedOllamaProvider', () => {
  it('rewrites a stored Codex Responses runtime to the Chat bridge', () => {
    const next = migrateManagedOllamaProvider({
      id: 'cindy-local-ollama',
      name: 'Ollama',
      auth: { method: 'none' },
      runtimes: {
        pi: {
          baseUrl: OLLAMA_OPENAI_BASE_URL,
          wireProtocol: 'openai-chat',
          models: [{ id: 'qwen3.8:27b-mxfp8', name: 'Qwen3.8' }],
        },
        'claude-code': {
          baseUrl: OLLAMA_ANTHROPIC_BASE_URL,
          wireProtocol: 'anthropic-messages',
          models: [{ id: 'qwen3.8:27b-mxfp8', name: 'Qwen3.8' }],
        },
        codex: {
          baseUrl: OLLAMA_OPENAI_BASE_URL,
          wireProtocol: 'openai-responses',
          models: [{ id: 'qwen3.8:27b-mxfp8', name: 'Qwen3.8' }],
        },
      },
    });
    expect(next?.runtimes.codex).toMatchObject({
      baseUrl: OLLAMA_OPENAI_BASE_URL,
      wireProtocol: 'openai-chat',
      models: [{ id: 'qwen3.8:27b-mxfp8' }],
    });
  });
});
