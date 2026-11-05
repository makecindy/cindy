import { describe, expect, it, vi } from 'vitest';
import { createPluginUiComposerAccess } from './pluginUiComposer.js';
import type { PluginUiComposerEffect } from './pluginUi.js';

// C5: the production endpoint binder must reject late edits after input, owner
// or editor replacement. It holds references to the original editor, no draft
// store. Unit tier; the Desktop editor uses this binder.
async function fixture() {
  const access = createPluginUiComposerAccess();
  let revision = '1', active = true;
  const apply = vi.fn(() => { revision = '2'; });
  const off = access.register('current-task', { current: () => active,
    snapshot: () => ({ draftKey: 'draft-1', revision, selection: { start: 2, end: 5 }, selectedText: 'old' }), apply });
  const ticket = (await access.capture('current-task', { operations: ['append'], readSelection: true }))!;
  const effect: PluginUiComposerEffect = { kind: 'composer-edit', operationId: 'operation-1', draftKey: 'draft-1',
    expectedDraftRevision: '1', selection: { start: 2, end: 5 }, operation: 'append', text: 'new' };
  return { access, ticket, effect, apply, off, edit: () => { revision = '2'; }, deactivate: () => { active = false; } };
}
describe('plugin UI local composer effects', () => {
  it('captures selection only for the declared read and applies a valid operation once', async () => {
    const h = await fixture(); expect(h.ticket.snapshot.selectedText).toBe('old');
    expect((await h.access.capture('current-task', { operations: ['append'], readSelection: false }))?.snapshot).not.toHaveProperty('selectedText');
    expect(await Promise.all([h.access.apply(h.ticket, h.effect), h.access.apply(h.ticket, h.effect)])).toEqual(['applied', 'applied']);
    expect(await h.access.apply(h.ticket, h.effect)).toBe('applied'); expect(h.apply).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite newer user input or accept an effect destination chosen elsewhere', async () => {
    const h = await fixture();
    expect(await h.access.apply(h.ticket, { ...h.effect, draftKey: 'another-draft' })).toBe('DRAFT_CHANGED');
    h.edit(); expect(await h.access.apply(h.ticket, h.effect)).toBe('DRAFT_CHANGED'); expect(h.apply).not.toHaveBeenCalled();
  });
  it('invalidates a departed endpoint and does not transfer its ticket to another display', async () => {
    const h = await fixture(), other = await fixture();
    expect(await other.access.apply(h.ticket, h.effect)).toBe('EDITOR_UNAVAILABLE');
    h.deactivate(); expect(await h.access.apply(h.ticket, h.effect)).toBe('EDITOR_UNAVAILABLE');
    h.off(); expect(h.access.has('current-task')).toBe(false); expect(h.apply).not.toHaveBeenCalled();
  });
  it('honors the editor write-time version check and does not treat it as a business failure', async () => {
    const access = createPluginUiComposerAccess();
    access.register('task', { current: () => true,
      snapshot: () => ({ draftKey: 'draft', revision: '1', selection: { start: 0, end: 0 } }),
      apply: () => false });
    const ticket = (await access.capture('task', { operations: ['append'], readSelection: false }))!;
    expect(await access.apply(ticket, { kind: 'composer-edit', operationId: 'op', draftKey: 'draft',
      expectedDraftRevision: '1', selection: { start: 0, end: 0 }, operation: 'append', text: 'text' })).toBe('DRAFT_CHANGED');
  });
});
