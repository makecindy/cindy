import { describe, expect, it } from 'vitest';

import type { Catalog } from '@cindy/model-providers';
import {
  resolveActiveSessionDefaultModel,
  withSessionDefaultModel,
} from '../agentCapabilitiesResponse';

const catalog = (
  defaults?: Catalog['defaults'],
): Pick<Catalog, 'providers' | 'defaults'> => ({ providers: [], defaults });

describe('withSessionDefaultModel', () => {
  it('projects the active catalog sessionModel into the capability response', () => {
    expect(
      withSessionDefaultModel(
        { availableModels: [{ id: 'deepseek/deepseek-v4-pro' }] },
        catalog({ codex: { sessionModel: 'deepseek/deepseek-v4-pro' } }),
        'codex',
      ),
    ).toEqual({
      availableModels: [{ id: 'deepseek/deepseek-v4-pro' }],
      sessionDefaultModel: 'deepseek/deepseek-v4-pro',
    });
  });

  it('gives a visible registry marker precedence over a stale catalog sessionModel', () => {
    const models = [
      { id: 'gpt-5.5', sortOrder: 1 },
      { id: 'deepseek/deepseek-v4-pro', sortOrder: 44, newSessionDefault: true },
    ];
    expect(
      resolveActiveSessionDefaultModel(
        models,
        catalog({ codex: { sessionModel: 'gpt-5.5' } }),
        'codex',
      ),
    ).toBe('deepseek/deepseek-v4-pro');
    expect(
      withSessionDefaultModel(
        { availableModels: models },
        catalog({ codex: { sessionModel: 'gpt-5.5' } }),
        'codex',
      ).sessionDefaultModel,
    ).toBe('deepseek/deepseek-v4-pro');
  });

  it('keeps the legacy fallback for old catalogs and omits an empty Pi default', () => {
    expect(withSessionDefaultModel({ availableModels: [] }, catalog(), 'claude-code')).toEqual({
      availableModels: [],
    });
    expect(withSessionDefaultModel({
      availableModels: [{ id: 'claude-sonnet-4-6' }],
    }, catalog(), 'claude-code')).toEqual({
      availableModels: [{ id: 'claude-sonnet-4-6' }],
      sessionDefaultModel: 'claude-sonnet-4-6',
    });
    expect(withSessionDefaultModel({ availableModels: [] }, catalog(), 'pi')).toEqual({
      availableModels: [],
    });
  });
});
