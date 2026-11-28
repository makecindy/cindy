// Unit: one model edit shared by the local model panel and the cloud instance, so both
// save the same config for the same choice.
import { describe, expect, it } from 'vitest';
import type { CustomProviderConfig } from '@cindy/model-providers';
import { applyCustomModelEdit } from '../customModelEdit';

const config = (): CustomProviderConfig =>
  ({
    id: 'web-1',
    name: 'Gateway',
    auth: { method: 'apiKey' },
    runtimes: {
      pi: {
        baseUrl: 'https://gateway.example.invalid/v1',
        wireProtocol: 'openai-chat',
        models: [{ id: 'm', name: 'M', api: 'openai-completions', piApi: 'openai-completions' }],
      },
    },
  }) as unknown as CustomProviderConfig;

describe('applyCustomModelEdit', () => {
  it('selects a catalog interface profile and clears explicit routing', () => {
    const value = config();
    expect(
      applyCustomModelEdit(value, 'pi', 'm', { kind: 'interface', api: 'auto', profile: true }),
    ).toBe(true);
    expect(value.runtimes.pi!.models[0]).toEqual({ id: 'm', name: 'M', interfaceId: 'auto' });
  });
  it('pins an explicit API and lets Pi keep the runtime endpoint', () => {
    const value = config();
    expect(
      applyCustomModelEdit(value, 'pi', 'm', {
        kind: 'interface',
        api: 'anthropic-messages',
        profile: false,
      }),
    ).toBe(true);
    const model = value.runtimes.pi!.models[0]!;
    expect(model).toMatchObject({ api: 'anthropic-messages', piApi: 'anthropic-messages' });
    expect(model.route).toBeUndefined();
    expect(model.interfaceId).toBeUndefined();
  });
  it('keeps an existing route and switches its wire protocol', () => {
    const value = config();
    value.runtimes.pi!.models[0]!.route = { baseUrl: 'https://gateway.example.invalid/v1', wireProtocol: 'openai-chat' };
    expect(
      applyCustomModelEdit(value, 'pi', 'm', { kind: 'interface', api: 'anthropic-messages', profile: false }),
    ).toBe(true);
    expect(value.runtimes.pi!.models[0]!.route?.wireProtocol).toBe('anthropic-messages');
  });
  it('sets and resets image capability', () => {
    const value = config();
    applyCustomModelEdit(value, 'pi', 'm', { kind: 'capability', media: 'image', value: 'edit' });
    expect(value.runtimes.pi!.models[0]).toMatchObject({
      mode: 'image_generation',
      modalities: { input: ['text', 'image'], output: ['image'] },
    });
    applyCustomModelEdit(value, 'pi', 'm', {
      kind: 'capability',
      media: 'image',
      value: 'default',
    });
    expect(value.runtimes.pi!.models[0]!.mode).toBeUndefined();
    expect(value.runtimes.pi!.models[0]!.modalities).toBeUndefined();
  });
  it('changes nothing for a missing model or an unknown API', () => {
    const value = config();
    const before = JSON.stringify(value);
    expect(
      applyCustomModelEdit(value, 'pi', 'gone', {
        kind: 'capability',
        media: 'video',
        value: 'generate',
      }),
    ).toBe(false);
    expect(
      applyCustomModelEdit(value, 'codex', 'm', { kind: 'interface', api: 'auto', profile: true }),
    ).toBe(false);
    expect(
      applyCustomModelEdit(value, 'pi', 'm', {
        kind: 'interface',
        api: 'not-an-api',
        profile: false,
      }),
    ).toBe(false);
    expect(JSON.stringify(value)).toBe(before);
  });
});
