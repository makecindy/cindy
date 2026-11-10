import { describe, expect, it } from 'vitest';
import { effectiveTeammateVision, parseTeammateMediaModels } from '../teammateMediaModels.js';

// Feature contract: parse persisted/remote overrides and merge them with live app policy.
// New domain has no earlier coverage. Minimal inputs distinguish inherit, empty fallback,
// exact provider identity and invalid shapes. Unit tier; no IO or external accounts.
describe('teammate media model overrides', () => {
  const app = { enabled: false, targetModels: ['text-model'], primary: { providerId: 'app', modelId: 'vision' }, fallback: { providerId: 'app', modelId: 'backup' } };
  it.each([undefined, null, {}, { vision: null, image: null, video: null }])('inherits and resets without storing app snapshots: %j', raw => {
    expect(parseTeammateMediaModels(raw)).toBeNull();
    expect(effectiveTeammateVision(app, parseTeammateMediaModels(raw))).toBe(app);
  });
  it('round-trips a complete override and preserves disabled/target policy and explicit empty fallback', () => {
    const parsed = parseTeammateMediaModels({ vision: { primary: { providerId: 'account', modelId: 'vision' }, fallback: null }, image: { providerId: 'pictures', modelId: 'image' }, video: { providerId: 'movies', modelId: 'video' } });
    const reloaded = parseTeammateMediaModels(JSON.parse(JSON.stringify(parsed)));
    expect(reloaded).toEqual(parsed);
    const effective = effectiveTeammateVision(app, reloaded);
    expect(effective).toEqual({ ...app, primary: { providerId: 'account', modelId: 'vision' }, fallback: null });
    expect(effectiveTeammateVision({ ...app, enabled: true }, reloaded).enabled).toBe(true);
    expect(app.fallback).toEqual({ providerId: 'app', modelId: 'backup' });
  });
  it.each([
    { vision: { primary: { providerId: 'a', modelId: 'b' } } },
    { image: { modelId: 'same-model' } },
    { video: { providerId: ' ', modelId: 'video' } },
    { image: { providerId: 'a', modelId: 'b', apiKey: 'not-a-key' } },
    { enabled: true },
    [],
  ])('rejects incomplete routes and unrelated policy/connection fields: %j', raw => {
    expect(() => parseTeammateMediaModels(raw)).toThrow();
  });
});
