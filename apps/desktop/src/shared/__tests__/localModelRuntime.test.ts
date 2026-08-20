import { describe, expect, it } from 'vitest';

import {
  classifyOllamaPullError,
  curatedOllamaDisplayName,
  detectOllamaPackaging,
  filterCuratedOllamaModels,
  isHfMlxPullName,
  isLocalRuntimeBetaProviderId,
  isOllamaModelName,
  normalizeOllamaPullName,
  ollamaModelRefsEqual,
  matchesManagedOllamaFingerprint,
  MANAGED_LMSTUDIO_PROVIDER_ID,
  MANAGED_OLLAMA_PROVIDER_ID,
  OLLAMA_ANTHROPIC_BASE_URL,
  OLLAMA_OPENAI_BASE_URL,
  pickFeaturedOllamaModels,
  recommendForHost,
  recommendQwen38,
  resolveCuratedOllamaCatalog,
  resolveManagedOllamaAgents,
  QWEN38_MLX,
  QWEN38_MXFP8,
} from '../localModelRuntime.js';

describe('localModelRuntime', () => {
  it('maps known Ollama library tags to catalog display names', () => {
    expect(curatedOllamaDisplayName('qwen3.8:27b-mxfp8')).toBe('Qwen3.8 27B');
    expect(curatedOllamaDisplayName('unknown-local:latest')).toBeUndefined();
  });

  it('reads packaging from the official tag', () => {
    expect(detectOllamaPackaging('qwen3.8:27b-mxfp8')).toBe('mxfp8');
    expect(detectOllamaPackaging('qwen3.8:27b-mlx')).toBe('mlx');
    expect(detectOllamaPackaging('gemma4:e4b-mlx')).toBe('mlx');
    expect(detectOllamaPackaging('qwen3.8:27b')).toBe('q4');
    expect(detectOllamaPackaging('qwen3-coder:30b')).toBeNull();
  });

  it('accepts official Ollama tags and rejects path/shell fragments', () => {
    expect(isOllamaModelName('qwen3.8:27b-mxfp8')).toBe(true);
    expect(isOllamaModelName('library/qwen3.8:27b')).toBe(true);
    expect(isOllamaModelName('../etc/passwd')).toBe(false);
    expect(isOllamaModelName('qwen3.8; rm -rf /')).toBe(false);
    expect(isOllamaModelName('http://127.0.0.1:11434')).toBe(false);
    expect(isOllamaModelName('hf.co/unsloth/Qwen3.8-27B-GGUF')).toBe(true);
  });

  it('normalizes Hugging Face URLs into Ollama hf.co pull names', () => {
    expect(normalizeOllamaPullName('hf.co/unsloth/Qwen3.8-27B-GGUF')).toBe(
      'hf.co/unsloth/Qwen3.8-27B-GGUF',
    );
    expect(normalizeOllamaPullName('https://huggingface.co/unsloth/Qwen3.8-27B-GGUF')).toBe(
      'hf.co/unsloth/Qwen3.8-27B-GGUF',
    );
    expect(
      normalizeOllamaPullName(
        'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-UD-Q4_K_XL.gguf',
      ),
    ).toBe('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL');
    expect(normalizeOllamaPullName('https://huggingface.co/datasets/foo/bar')).toBeNull();
    expect(normalizeOllamaPullName('https://example.com/unsloth/Qwen3.8-27B-GGUF')).toBeNull();
  });

  it('treats an untagged Ollama name as its :latest alias', () => {
    expect(ollamaModelRefsEqual('glm-4.7-flash', 'glm-4.7-flash:latest')).toBe(true);
    expect(ollamaModelRefsEqual('library/foo', 'library/foo:latest')).toBe(true);
    expect(ollamaModelRefsEqual('hf.co/unsloth/Qwen3.8-27B-GGUF', 'hf.co/unsloth/Qwen3.8-27B-GGUF:latest')).toBe(
      true,
    );
    expect(ollamaModelRefsEqual('gpt-oss:20b', 'gpt-oss:latest')).toBe(false);
    expect(ollamaModelRefsEqual('qwen3.8:27b-mxfp8', 'qwen3.8:latest')).toBe(false);
  });

  it('explains Hugging Face MLX repos that Ollama cannot pull', () => {
    expect(isHfMlxPullName('hf.co/ornith-ai/Ornith-1.5-35B-A3B-MLX')).toBe(true);
    expect(isHfMlxPullName('gemma4:12b-mlx')).toBe(false);
    expect(isHfMlxPullName('hf.co/unsloth/Qwen3.8-27B-GGUF')).toBe(false);
    expect(
      classifyOllamaPullError(
        'pull model manifest: 400: {"error":"Repository is not GGUF or is not compatible with llama.cpp"}',
      ),
    ).toBe('not-gguf');
    expect(classifyOllamaPullError('not-found')).toBe('not-found');
    expect(classifyOllamaPullError('connection refused')).toBe('refused');
  });

  it('does not recommend 27B below 32GB or off Apple Silicon', () => {
    expect(
      recommendQwen38({ platform: 'darwin', arch: 'x64', totalmemBytes: 128 * 1024 ** 3 }),
    ).toBeNull();
    expect(
      recommendQwen38({ platform: 'darwin', arch: 'arm64', totalmemBytes: 24 * 1024 ** 3 }),
    ).toBeNull();
    expect(
      recommendQwen38({ platform: 'win32', arch: 'arm64', totalmemBytes: 128 * 1024 ** 3 }),
    ).toBeNull();
  });

  it('picks mlx then mxfp8 by unified memory', () => {
    expect(
      recommendQwen38({ platform: 'darwin', arch: 'arm64', totalmemBytes: 36 * 1024 ** 3 }),
    ).toEqual(QWEN38_MLX);
    expect(
      recommendQwen38({ platform: 'darwin', arch: 'arm64', totalmemBytes: 128 * 1024 ** 3 }),
    ).toEqual(QWEN38_MXFP8);
  });

  it('keeps featured picks tiny and lets search find multilingual aliases', () => {
    const appleMax = {
      platform: 'darwin' as const,
      arch: 'arm64',
      totalmemBytes: 128 * 1024 ** 3,
    };
    const catalog = resolveCuratedOllamaCatalog(appleMax);
    expect(pickFeaturedOllamaModels(appleMax).map((model) => model.id)).toEqual([
      'qwen38-27b',
      'ornith15-35b',
    ]);
    expect(catalog.some((model) => model.id === 'gemma4-e4b')).toBe(true);
    expect(catalog.some((model) => model.id === 'gemma4-31b')).toBe(true);
    expect(catalog.some((model) => model.id === 'glm-47-flash')).toBe(true);
    expect(catalog.some((model) => model.id === 'llama3.2-3b')).toBe(false);
    expect(catalog.some((model) => model.id === 'phi4')).toBe(false);
    expect(catalog.some((model) => model.id === 'qwen25-7b')).toBe(false);
    expect(catalog.some((model) => model.id === 'gemma3-12b')).toBe(false);
    expect(
      catalog.find((model) => model.id === 'ornith15-35b')?.libraryName,
    ).toBe('hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M');
    expect(filterCuratedOllamaModels(catalog, '通义').map((model) => model.id)).toContain(
      'qwen38-27b',
    );
    expect(filterCuratedOllamaModels(catalog, '宝石').map((model) => model.id)).toEqual([
      'gemma4-e2b',
      'gemma4-e4b',
      'gemma4-12b',
      'gemma4-31b',
      'gemma4-26b',
    ]);
    expect(filterCuratedOllamaModels(catalog, '编程').map((model) => model.id)).toContain(
      'ornith15-35b',
    );
    expect(filterCuratedOllamaModels(catalog, '编程').map((model) => model.id)).not.toContain(
      'gemma4-12b',
    );
    expect(
      pickFeaturedOllamaModels({
        platform: 'darwin',
        arch: 'arm64',
        totalmemBytes: 16 * 1024 ** 3,
      }).map((model) => model.id),
    ).toEqual(['gpt-oss-20b']);
  });

  it('picks a machine-specific primary model for every host class', () => {
    expect(
      recommendForHost({
        platform: 'darwin',
        arch: 'arm64',
        totalmemBytes: 128 * 1024 ** 3,
      }),
    ).toMatchObject({ reason: 'apple-mxfp8', primary: { libraryName: 'qwen3.8:27b-mxfp8' } });
    expect(
      recommendForHost({
        platform: 'darwin',
        arch: 'arm64',
        totalmemBytes: 36 * 1024 ** 3,
      }),
    ).toMatchObject({ reason: 'apple-mlx', primary: { libraryName: 'qwen3.8:27b-mlx' } });
    expect(
      recommendForHost({
        platform: 'win32',
        arch: 'x64',
        totalmemBytes: 64 * 1024 ** 3,
      }),
    ).toMatchObject({ reason: 'generic-27b', primary: { libraryName: 'qwen3.8:27b' } });
    expect(
      recommendForHost({
        platform: 'linux',
        arch: 'x64',
        totalmemBytes: 16 * 1024 ** 3,
      }),
    ).toMatchObject({ reason: 'compact', primary: { id: 'gpt-oss-20b' } });
    expect(
      recommendForHost({
        platform: 'linux',
        arch: 'x64',
        totalmemBytes: 0,
      }).reason,
    ).toBe('unknown');
  });

  it('falls back to bundled curated data when remote entries fail the allowlist', () => {
    const catalog = resolveCuratedOllamaCatalog(
      { platform: 'darwin', arch: 'arm64', totalmemBytes: 128 * 1024 ** 3 },
      {
        version: 1,
        qwen38: {
          id: 'qwen38-27b',
          name: 'Hacked',
          aliases: ['qwen'],
          mxfp8: {
            libraryName: 'https://evil.example/model',
            sizeBytes: 32 * 1024 ** 3,
            minUnifiedMemoryGb: 64,
            appleSiliconOnly: true,
          },
          mlx: {
            libraryName: 'qwen3.8:27b-mlx',
            sizeBytes: 18 * 1024 ** 3,
            minUnifiedMemoryGb: 32,
            appleSiliconOnly: true,
          },
          generic: {
            libraryName: 'qwen3.8:27b',
            sizeBytes: 18 * 1024 ** 3,
            minUnifiedMemoryGb: 32,
          },
        },
        featuredIds: ['qwen38-27b'],
        models: [],
      },
    );
    expect(catalog[0]?.name).toBe('Qwen3.8 27B');
    expect(catalog[0]?.libraryName).toBe('qwen3.8:27b-mxfp8');
  });

  it('requires the managed Ollama fingerprint, not just the id', () => {
    expect(
      matchesManagedOllamaFingerprint({
        id: MANAGED_OLLAMA_PROVIDER_ID,
        authMethod: 'none',
        runtimes: { pi: { baseUrl: OLLAMA_OPENAI_BASE_URL, wireProtocol: 'openai-chat' } },
      }),
    ).toBe(true);
    expect(
      matchesManagedOllamaFingerprint({
        id: MANAGED_OLLAMA_PROVIDER_ID,
        authMethod: 'apiKey',
        runtimes: { pi: { baseUrl: OLLAMA_OPENAI_BASE_URL, wireProtocol: 'openai-chat' } },
      }),
    ).toBe(false);
    expect(
      matchesManagedOllamaFingerprint({
        id: MANAGED_OLLAMA_PROVIDER_ID,
        authMethod: 'none',
        runtimes: { pi: { baseUrl: 'http://127.0.0.1:9999/v1', wireProtocol: 'openai-chat' } },
      }),
    ).toBe(false);
    expect(
      matchesManagedOllamaFingerprint({
        id: MANAGED_OLLAMA_PROVIDER_ID,
        authMethod: 'none',
        runtimes: {
          pi: { baseUrl: OLLAMA_OPENAI_BASE_URL },
          'claude-code': { baseUrl: OLLAMA_OPENAI_BASE_URL },
        },
      }),
    ).toBe(false);
    expect(
      matchesManagedOllamaFingerprint({
        id: MANAGED_OLLAMA_PROVIDER_ID,
        authMethod: 'none',
        runtimes: {
          pi: {
            baseUrl: OLLAMA_OPENAI_BASE_URL,
            wireProtocol: 'openai-chat',
            headers: { Authorization: 'x' },
          },
        },
      }),
    ).toBe(false);
    expect(
      matchesManagedOllamaFingerprint({
        id: MANAGED_OLLAMA_PROVIDER_ID,
        authMethod: 'none',
        runtimes: {
          pi: { baseUrl: OLLAMA_OPENAI_BASE_URL, wireProtocol: 'openai-chat' },
          'claude-code': {
            baseUrl: OLLAMA_ANTHROPIC_BASE_URL,
            wireProtocol: 'anthropic-messages',
          },
          codex: { baseUrl: OLLAMA_OPENAI_BASE_URL, wireProtocol: 'openai-responses' },
        },
      }),
    ).toBe(true);
    expect(
      matchesManagedOllamaFingerprint({
        id: MANAGED_OLLAMA_PROVIDER_ID,
        authMethod: 'none',
        runtimes: {
          pi: { baseUrl: OLLAMA_OPENAI_BASE_URL, wireProtocol: 'openai-chat' },
          'claude-code': {
            baseUrl: OLLAMA_ANTHROPIC_BASE_URL,
            wireProtocol: 'anthropic-messages',
          },
          codex: { baseUrl: OLLAMA_OPENAI_BASE_URL, wireProtocol: 'openai-chat' },
        },
      }),
    ).toBe(true);
  });

  it('assigns CC/Codex only when the daemon is new enough and tools exist', () => {
    expect(resolveManagedOllamaAgents({ version: '0.6.2' })).toEqual(['pi']);
    expect(
      resolveManagedOllamaAgents({
        version: '0.32.13',
        capabilities: ['completion', 'tools', 'thinking', 'vision'],
        requires: '0.32.12',
      }),
    ).toEqual(['pi', 'claude-code', 'codex']);
    expect(
      resolveManagedOllamaAgents({
        version: '0.32.0',
        requires: '0.32.12',
      }),
    ).toEqual(['pi']);
    expect(
      resolveManagedOllamaAgents({
        version: '0.32.14',
        capabilities: ['completion'],
      }),
    ).toEqual(['pi']);
  });

  it('marks local runtimes as beta, including generated llama.cpp / vLLM ids', () => {
    expect(isLocalRuntimeBetaProviderId(MANAGED_OLLAMA_PROVIDER_ID)).toBe(true);
    expect(isLocalRuntimeBetaProviderId(MANAGED_LMSTUDIO_PROVIDER_ID)).toBe(true);
    expect(isLocalRuntimeBetaProviderId('lmstudio')).toBe(true);
    expect(isLocalRuntimeBetaProviderId('llamacpp')).toBe(true);
    expect(isLocalRuntimeBetaProviderId('llama-cpp')).toBe(true);
    expect(isLocalRuntimeBetaProviderId('llama-cpp-2')).toBe(true);
    expect(isLocalRuntimeBetaProviderId('vllm')).toBe(true);
    expect(isLocalRuntimeBetaProviderId('vllm-3')).toBe(true);
    expect(isLocalRuntimeBetaProviderId('openrouter')).toBe(false);
    expect(isLocalRuntimeBetaProviderId('litellm')).toBe(false);
  });
});
