import { describe, expect, it } from 'vitest';

import type { ProviderWireProtocol } from '@cindy/model-providers';

import {
  applyRuntimeFillFields,
  buildRuntimeFillDiffs,
  cloneRuntimeFillDraft,
  mergeHydratedRuntimeKeys,
  normalizeRuntimeFillSelection,
  runtimeFillFieldsForToggle,
  runtimeFillHeaderCount,
  runtimeFillHasUnreviewedConflict,
  runtimeFillModelCount,
  runtimeFillEndpointUrlsChanged,
  runtimeFillSelectedTargetChanged,
  runtimeFillTargetAgents,
  type RuntimeFillDraft,
} from '../customProviderRuntimeFill';

function draft(
  overrides: Partial<RuntimeFillDraft> & { wireProtocol?: ProviderWireProtocol } = {},
): RuntimeFillDraft {
  return {
    baseUrl: '',
    requestPath: '',
    apiKey: '',
    wireProtocol: 'openai-chat',
    models: [],
    headers: [],
    modelsUrl: '',
    ...overrides,
  };
}

describe('custom provider runtime fill', () => {
  it('only treats base or model-list URL changes as endpoint changes for key retention', () => {
    const previous = draft({
      baseUrl: 'https://same.example/v1',
      requestPath: '/old-path',
      modelsUrl: 'https://same.example/v1/models',
    });
    expect(
      runtimeFillEndpointUrlsChanged(previous, {
        ...previous,
        requestPath: '/new-path',
        wireProtocol: 'openai-responses',
      }),
    ).toBe(false);
    expect(
      runtimeFillEndpointUrlsChanged(previous, {
        ...previous,
        baseUrl: 'https://new.example/v1',
      }),
    ).toBe(true);
  });

  it('excludes Pi as a target when the provider uses OAuth', () => {
    expect(runtimeFillTargetAgents('codex', { includePi: false })).toEqual(['claude-code']);
    expect(runtimeFillTargetAgents('codex', { includePi: true })).toEqual(['claude-code', 'pi']);
  });

  it('treats endpoint URL, default request path, and protocol as one atomic selection', () => {
    const source = draft({
      baseUrl: 'https://anthropic.example/v1',
      requestPath: '',
      wireProtocol: 'anthropic-messages',
    });
    const target = draft({
      baseUrl: 'https://openai.example/v1',
      requestPath: '/responses',
      wireProtocol: 'openai-responses',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'claude-code',
      targetAgent: 'codex',
    });

    expect(diffs.slice(0, 3).map((diff) => diff.field)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
    ]);
    expect(runtimeFillFieldsForToggle('requestPath', diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
    ]);
    expect(normalizeRuntimeFillSelection(['baseUrl'], diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
    ]);

    // The apply guard also expands a partial caller selection, so a future UI cannot
    // accidentally retain /responses while switching to Anthropic Messages.
    expect(
      applyRuntimeFillFields(target, source, ['requestPath'], {
        sourceAgent: 'claude-code',
        targetAgent: 'codex',
      }),
    ).toMatchObject({
      baseUrl: 'https://anthropic.example/v1',
      requestPath: '',
      wireProtocol: 'anthropic-messages',
    });
  });

  it('reports unsupported endpoint fields and refuses to apply them', () => {
    const source = draft({
      baseUrl: 'https://openai.example/v1',
      requestPath: '/responses',
      wireProtocol: 'openai-responses',
      headers: [{ name: 'X-Route', value: 'responses' }],
    });
    const target = draft({
      baseUrl: 'https://anthropic.example/v1',
      wireProtocol: 'anthropic-messages',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'claude-code',
    });

    expect(
      diffs
        .filter((diff) =>
          ['baseUrl', 'requestPath', 'wireProtocol', 'headers'].includes(diff.field),
        )
        .every((diff) => diff.targetState === 'incompatible'),
    ).toBe(true);
    expect(
      diffs
        .filter((diff) =>
          ['baseUrl', 'requestPath', 'wireProtocol', 'headers'].includes(diff.field),
        )
        .every((diff) => diff.incompatibilityReason === 'protocol'),
    ).toBe(true);
    expect(runtimeFillFieldsForToggle('baseUrl', diffs)).toEqual([]);
    expect(
      applyRuntimeFillFields(
        target,
        source,
        ['baseUrl', 'requestPath', 'wireProtocol', 'headers'],
        {
          sourceAgent: 'codex',
          targetAgent: 'claude-code',
        },
      ),
    ).toEqual(target);
  });

  it('rejects the whole inference endpoint when a non-empty request path crosses Pi', () => {
    const source = draft({
      baseUrl: 'https://openai.example/v1',
      requestPath: '/responses',
      modelsUrl: 'https://openai.example/v1/models',
      wireProtocol: 'openai-responses',
    });
    const target = draft({
      baseUrl: 'https://pi.example/v1',
      requestPath: '/old-path',
      modelsUrl: 'https://pi.example/v1/old-models',
      wireProtocol: 'openai-chat',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'pi',
    });

    expect(
      diffs
        .filter((diff) => ['baseUrl', 'requestPath', 'wireProtocol'].includes(diff.field))
        .every((diff) => diff.targetState === 'incompatible'),
    ).toBe(true);
    expect(
      diffs
        .filter((diff) => ['baseUrl', 'requestPath', 'wireProtocol'].includes(diff.field))
        .every((diff) => diff.incompatibilityReason === 'endpoint'),
    ).toBe(true);
    expect(diffs.find((diff) => diff.field === 'modelsUrl')?.targetState).toBe('conflict');
    expect(runtimeFillFieldsForToggle('baseUrl', diffs)).toEqual([]);
    expect(normalizeRuntimeFillSelection(['apiKey'], diffs)).toEqual([]);
    expect(
      applyRuntimeFillFields(
        target,
        source,
        ['baseUrl', 'requestPath', 'wireProtocol', 'modelsUrl', 'apiKey'],
        {
          sourceAgent: 'codex',
          targetAgent: 'pi',
        },
      ),
    ).toMatchObject({
      baseUrl: target.baseUrl,
      wireProtocol: target.wireProtocol,
      requestPath: '',
      modelsUrl: source.modelsUrl,
      apiKey: target.apiKey,
    });

    const piSource = draft({
      baseUrl: 'https://pi.example/v1',
      requestPath: '/ignored-by-pi',
      modelsUrl: 'https://pi.example/v1/models',
      wireProtocol: 'openai-chat',
    });
    const codexTarget = draft({
      baseUrl: 'https://old.example/v1',
      wireProtocol: 'openai-responses',
    });
    const reverseDiffs = buildRuntimeFillDiffs(piSource, codexTarget, {
      includeApiKey: true,
      sourceAgent: 'pi',
      targetAgent: 'codex',
    });
    expect(
      reverseDiffs
        .filter((diff) => ['baseUrl', 'requestPath', 'wireProtocol'].includes(diff.field))
        .every((diff) => diff.targetState === 'incompatible'),
    ).toBe(true);
    expect(reverseDiffs.find((diff) => diff.field === 'modelsUrl')?.targetState).toBe('empty');
  });

  it('copies a path-free endpoint and models URL across Pi', () => {
    const source = draft({
      baseUrl: 'https://openai.example/v1',
      wireProtocol: 'openai-responses',
      modelsUrl: 'https://openai.example/v1/models',
    });
    const target = draft({
      baseUrl: 'https://pi.example/v1',
      requestPath: '/legacy-path',
      wireProtocol: 'openai-chat',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'pi',
    });

    expect(runtimeFillFieldsForToggle('baseUrl', diffs)).toEqual([
      'baseUrl',
      'wireProtocol',
      'modelsUrl',
    ]);
    expect(diffs.find((diff) => diff.field === 'modelsUrl')?.targetState).toBe('empty');
    expect(
      applyRuntimeFillFields(target, source, ['baseUrl', 'wireProtocol', 'modelsUrl'], {
        sourceAgent: 'codex',
        targetAgent: 'pi',
      }),
    ).toMatchObject({
      baseUrl: source.baseUrl,
      requestPath: '',
      wireProtocol: source.wireProtocol,
      modelsUrl: source.modelsUrl,
    });
  });

  it('treats hidden stored target headers as a conflict without exposing their values', () => {
    const source = draft({
      baseUrl: 'https://source.example/v1',
      headers: [{ name: 'X-Tenant', value: 'source-tenant' }],
    });
    const target = draft({
      baseUrl: 'https://target.example/v1',
      headersState: 'configured',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'codex',
    });

    expect(diffs.find((diff) => diff.field === 'headers')?.targetState).toBe('conflict');
    expect(
      applyRuntimeFillFields(target, source, ['headers'], {
        sourceAgent: 'codex',
        targetAgent: 'codex',
      }),
    ).toMatchObject({
      headers: source.headers,
      headersState: undefined,
    });
  });

  it('requires endpoint confirmation before clearing hidden target headers', () => {
    const source = draft({ baseUrl: 'https://source.example/v1' });
    const target = draft({
      baseUrl: 'https://target.example/v1',
      headersState: 'configured',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'codex',
    });

    expect(diffs.find((diff) => diff.field === 'headers')).toEqual({
      field: 'headers',
      targetState: 'conflict',
      implicitClear: true,
    });
    expect(runtimeFillFieldsForToggle('baseUrl', diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
      'headers',
    ]);
    expect(runtimeFillFieldsForToggle('headers', diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
      'headers',
    ]);
    expect(
      applyRuntimeFillFields(target, source, ['baseUrl', 'requestPath', 'wireProtocol', 'headers'], {
        sourceAgent: 'codex',
        targetAgent: 'codex',
      }),
    ).toMatchObject({
      baseUrl: source.baseUrl,
      headers: [],
      headersState: undefined,
    });
  });

  it('binds a changed models URL to the endpoint and credential-clear bundle', () => {
    const source = draft({
      baseUrl: 'https://source.example/v1',
      modelsUrl: 'https://source.example/models',
    });
    const target = draft({
      baseUrl: 'https://target.example/v1',
      modelsUrl: 'https://target.example/models',
      headersState: 'configured',
      apiKey: 'target-key',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'codex',
    });

    expect(diffs.find((diff) => diff.field === 'modelsUrl')).toMatchObject({
      targetState: 'conflict',
      implicitClear: true,
    });
    expect(runtimeFillFieldsForToggle('modelsUrl', diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
      'apiKey',
      'headers',
      'modelsUrl',
    ]);
    expect(
      applyRuntimeFillFields(target, source, ['modelsUrl'], {
        sourceAgent: 'codex',
        targetAgent: 'codex',
      }),
    ).toMatchObject({
      baseUrl: source.baseUrl,
      modelsUrl: source.modelsUrl,
      headersState: undefined,
      headers: [],
    });
  });

  it('binds target API-key clearing to an endpoint fill when source has no key', () => {
    const source = draft({ baseUrl: 'https://source.example/v1' });
    const target = draft({
      baseUrl: 'https://target.example/v1',
      apiKey: 'target-key',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: false,
      sourceAgent: 'codex',
      targetAgent: 'codex',
    });

    expect(diffs.find((diff) => diff.field === 'apiKey')).toMatchObject({
      targetState: 'conflict',
      implicitClear: true,
    });
    expect(runtimeFillFieldsForToggle('baseUrl', diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
      'apiKey',
    ]);
    expect(
      applyRuntimeFillFields(target, source, ['baseUrl'], {
        sourceAgent: 'codex',
        targetAgent: 'codex',
      }),
    ).toMatchObject({ baseUrl: source.baseUrl, apiKey: '' });
  });

  it('clears an explicit target models URL when the source uses inference', () => {
    const source = draft({ baseUrl: 'https://source.example/v1', modelsUrl: '' });
    const target = draft({
      baseUrl: 'https://target.example/v1',
      modelsUrl: 'https://target.example/custom-models',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'codex',
    });

    expect(diffs.find((diff) => diff.field === 'modelsUrl')).toEqual({
      field: 'modelsUrl',
      targetState: 'conflict',
      implicitClear: true,
    });
    expect(runtimeFillFieldsForToggle('baseUrl', diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
      'modelsUrl',
    ]);
    expect(normalizeRuntimeFillSelection(['modelsUrl'], diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
      'modelsUrl',
    ]);
    expect(
      applyRuntimeFillFields(target, source, ['baseUrl', 'requestPath', 'wireProtocol', 'modelsUrl'], {
        sourceAgent: 'codex',
        targetAgent: 'codex',
      }),
    ).toMatchObject({
      baseUrl: source.baseUrl,
      modelsUrl: '',
    });
  });

  it('blocks endpoint transfer when source headers exist only in main storage', () => {
    const source = draft({
      baseUrl: 'https://source.example/v1',
      modelsUrl: 'https://source.example/v1/models',
      headersState: 'configured',
    });
    const target = draft({ baseUrl: 'https://target.example/v1' });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'pi',
    });

    expect(
      diffs
        .filter((diff) => ['baseUrl', 'requestPath', 'wireProtocol', 'headers', 'modelsUrl'].includes(diff.field))
        .every(
          (diff) =>
            diff.targetState === 'incompatible' && diff.incompatibilityReason === 'headers',
        ),
    ).toBe(true);
    expect(runtimeFillFieldsForToggle('baseUrl', diffs)).toEqual([]);
    expect(
      applyRuntimeFillFields(target, source, ['baseUrl', 'wireProtocol', 'headers', 'modelsUrl'], {
        sourceAgent: 'codex',
        targetAgent: 'pi',
      }),
    ).toMatchObject(target);
  });

  it('blocks endpoint-bound fields when target header storage is unreadable', () => {
    const source = draft({
      baseUrl: 'https://source.example/v1',
      models: [{ id: 'model', name: 'Model' }],
    });
    const target = draft({
      baseUrl: 'https://target.example/v1',
      headersState: 'unknown',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'codex',
    });
    expect(diffs.find((diff) => diff.field === 'baseUrl')).toMatchObject({
      targetState: 'incompatible',
      incompatibilityReason: 'headers',
    });
    expect(diffs.find((diff) => diff.field === 'models')?.targetState).toBe('empty');
    expect(
      applyRuntimeFillFields(target, source, ['baseUrl', 'headers', 'modelsUrl'], {
        sourceAgent: 'codex',
        targetAgent: 'codex',
      }),
    ).toMatchObject(target);
  });

  it('does not copy an endpoint-bound API key when source headers hide the endpoint transfer', () => {
    const source = draft({
      baseUrl: 'https://source.example/v1',
      modelsUrl: 'https://source.example/v1/models',
      apiKey: 'source-key',
      headersState: 'configured',
    });
    const target = draft({
      baseUrl: 'https://target.example/v1',
      modelsUrl: 'https://target.example/v1/models',
      apiKey: '',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'codex',
      targetAgent: 'pi',
    });

    expect(diffs.find((diff) => diff.field === 'apiKey')).toMatchObject({
      targetState: 'incompatible',
      incompatibilityReason: 'headers',
    });
    expect(normalizeRuntimeFillSelection(['apiKey'], diffs)).toEqual([]);
    expect(
      applyRuntimeFillFields(target, source, ['apiKey'], {
        sourceAgent: 'codex',
        targetAgent: 'pi',
      }),
    ).toMatchObject(target);
  });

  it('clears a legacy target request path when filling from a path-free Pi source', () => {
    const source = draft({
      baseUrl: 'https://pi.example/v1',
      wireProtocol: 'openai-chat',
    });
    const target = draft({
      baseUrl: 'https://old.example/v1',
      requestPath: '/responses',
      wireProtocol: 'openai-responses',
    });
    const diffs = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'pi',
      targetAgent: 'codex',
    });

    expect(diffs.find((diff) => diff.field === 'requestPath')?.targetState).toBe('conflict');
    expect(runtimeFillFieldsForToggle('baseUrl', diffs)).toEqual([
      'baseUrl',
      'requestPath',
      'wireProtocol',
    ]);
    expect(
      applyRuntimeFillFields(target, source, ['baseUrl', 'requestPath', 'wireProtocol'], {
        sourceAgent: 'pi',
        targetAgent: 'codex',
      }),
    ).toMatchObject({
      baseUrl: source.baseUrl,
      requestPath: '',
      wireProtocol: source.wireProtocol,
    });
  });

  it('preserves Pi-only model capabilities when portable model fields are filled', () => {
    const source = draft({
      models: [{ id: 'model-a', name: 'Model A', contextWindow: 128_000 }],
    });
    const target = draft({
      models: [
        {
          id: 'model-a',
          name: 'Old name',
          contextWindow: 32_000,
          supportsImageInput: true,
          reasoning: true,
          reasoningEfforts: ['low', 'high'],
        },
      ],
    });

    const result = applyRuntimeFillFields(target, source, ['models'], {
      sourceAgent: 'claude-code',
      targetAgent: 'pi',
    });
    expect(result.models).toEqual([
      {
        id: 'model-a',
        name: 'Model A',
        contextWindow: 128_000,
        supportsImageInput: true,
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
      },
    ]);
  });

  it('ignores Pi-only capabilities when comparing or filling a non-Pi target', () => {
    const source = draft({
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          supportsImageInput: true,
          reasoning: true,
          reasoningEfforts: ['low'],
        },
      ],
    });
    const target = draft({ models: [{ id: 'model-a', name: 'Model A' }] });
    const modelDiff = buildRuntimeFillDiffs(source, target, {
      includeApiKey: true,
      sourceAgent: 'pi',
      targetAgent: 'codex',
    }).find((diff) => diff.field === 'models');

    expect(modelDiff?.targetState).toBe('same');
    expect(
      applyRuntimeFillFields(target, source, ['models'], {
        sourceAgent: 'pi',
        targetAgent: 'codex',
      }).models,
    ).toEqual([{ id: 'model-a', name: 'Model A' }]);
  });

  it('uses the same model and header counting semantics as save', () => {
    const value = draft({
      models: [
        { id: 'valid', name: 'Valid' },
        { id: 'missing-name', name: '' },
        { id: '', name: 'Missing id' },
      ],
      headers: [
        { name: 'X-Test', value: 'first' },
        { name: '', value: 'discarded' },
        { name: 'X-Test', value: 'last' },
      ],
    });

    expect(runtimeFillModelCount(value)).toBe(1);
    expect(runtimeFillHeaderCount(value)).toBe(1);
    expect(
      applyRuntimeFillFields(draft(), value, ['models', 'headers'], {
        sourceAgent: 'codex',
        targetAgent: 'pi',
      }),
    ).toMatchObject({
      models: [{ id: 'valid', name: 'Valid' }],
      headers: [{ name: 'X-Test', value: 'last' }],
    });
  });

  it('takes a deep snapshot for review and apply', () => {
    const source = draft({
      models: [{ id: 'model-a', name: 'Model A', reasoningEfforts: ['low'] }],
      headers: [{ name: 'X-Test', value: 'one' }],
    });
    const snapshot = cloneRuntimeFillDraft(source);

    source.models[0].name = 'Changed';
    source.models[0].reasoningEfforts?.push('high');
    source.headers[0].value = 'two';

    expect(snapshot.models[0]).toMatchObject({
      name: 'Model A',
      reasoningEfforts: ['low'],
    });
    expect(snapshot.headers[0]).toEqual({ name: 'X-Test', value: 'one' });
  });

  it('does not let late key hydration overwrite a user edit or runtime fill', () => {
    const drafts = {
      'claude-code': draft({ apiKey: 'saved-claude' }),
      codex: draft({ apiKey: 'newly-copied-codex' }),
      pi: draft({ apiKey: '' }),
    };
    const revisionAtStart = { 'claude-code': 0, codex: 0, pi: 0 };
    const currentRevision = { 'claude-code': 0, codex: 1, pi: 0 };

    const merged = mergeHydratedRuntimeKeys(
      drafts,
      { 'claude-code': 'stored-claude', codex: 'stale-codex', pi: 'stored-pi' },
      {
        'claude-code': { baseUrl: '', modelsUrl: '' },
        codex: { baseUrl: '', modelsUrl: '' },
        pi: { baseUrl: '', modelsUrl: '' },
      },
      revisionAtStart,
      currentRevision,
    );

    expect(merged['claude-code'].apiKey).toBe('stored-claude');
    expect(merged.codex.apiKey).toBe('newly-copied-codex');
    expect(merged.pi.apiKey).toBe('stored-pi');
  });

  it('does not hydrate a saved key after the credential endpoint changed', () => {
    const drafts = {
      'claude-code': draft(),
      codex: draft({ baseUrl: 'https://new.example/v1' }),
      pi: draft(),
    };
    const revisions = { 'claude-code': 0, codex: 0, pi: 0 };

    const merged = mergeHydratedRuntimeKeys(
      drafts,
      { codex: 'stored-codex' },
      { codex: { baseUrl: 'https://saved.example/v1', modelsUrl: '' } },
      revisions,
      revisions,
    );

    expect(merged.codex.apiKey).toBe('');
  });

  it('requires a new confirmation if a selected target becomes occupied after review', () => {
    const previous = [{ field: 'apiKey', targetState: 'empty' }] as const;
    const fresh = [{ field: 'apiKey', targetState: 'conflict' }] as const;

    expect(runtimeFillHasUnreviewedConflict(previous, fresh, ['apiKey'])).toBe(true);
    expect(runtimeFillHasUnreviewedConflict(previous, fresh, ['models'])).toBe(false);
    expect(runtimeFillHasUnreviewedConflict(fresh, fresh, ['apiKey'])).toBe(false);
  });

  it('requires a new confirmation if a selected conflicting value changes after review', () => {
    const previous = draft({ models: [{ id: 'old', name: 'Old' }] });
    const fresh = draft({ models: [{ id: 'new', name: 'New' }] });

    expect(runtimeFillSelectedTargetChanged(previous, fresh, ['models'], 'codex')).toBe(true);
    expect(runtimeFillSelectedTargetChanged(previous, fresh, ['apiKey'], 'codex')).toBe(false);
  });
});
