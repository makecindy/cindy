import { describe, expect, it } from 'vitest';
import { modelNeedsReselection } from '@/session/modelReselection';

describe('model reselection after hiding', () => {
  const visibility = { 'codex:a:model': false, 'codex:b:model': true, 'pi:a:model': true };
  it('requires an explicit replacement for the exact hidden source, even if another offers the model', () => {
    expect(modelNeedsReselection(visibility, 'codex', 'model', 'a')).toBe(true);
    expect(modelNeedsReselection(visibility, 'codex', 'model', 'b')).toBe(false);
    expect(modelNeedsReselection(visibility, 'pi', 'model', 'a')).toBe(false);
  });
  it('does not infer hidden state from a failed or old-host catalog read', () => {
    expect(modelNeedsReselection(undefined, 'codex', 'model', 'a')).toBe(false);
    expect(modelNeedsReselection({}, 'codex', 'model', 'a')).toBe(false);
  });
  it('handles default source and model IDs with colons without falling back to another model', () => {
    expect(modelNeedsReselection(visibility, 'codex', 'model', null)).toBe(false);
    expect(modelNeedsReselection({ 'pi:a:org/model:free': false }, 'pi', 'org/model:free', null)).toBe(true);
    expect(modelNeedsReselection({ 'pi:a:org/model:free': false }, 'pi', 'model:free', null)).toBe(false);
  });
});
