import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import {
  addPlanModeComposerCommand,
  consumePlanModeComposerCommand,
  isPlanModeComposerCommandText,
  planModeComposerDraftText,
  shouldPreservePlanModeComposerDraft,
} from '../components/new-chat/planModeComposerCommand';
import type { UnifiedCommand } from '../lib/slashCommands';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
});

const desktopCommand = (name: string): UnifiedCommand => ({
  kind: 'desktop',
  name,
  description: `${name} command`,
});

function stateWithText(text: string): EditorState {
  return EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text(text))),
  });
}

describe('/plan composer command', () => {
  it('is only advertised when available and preserves an existing command', () => {
    const commands = [desktopCommand('help')];
    const existing: UnifiedCommand[] = [
      { kind: 'agent-skill', name: 'PLAN', source: 'skill' },
    ];

    expect(addPlanModeComposerCommand(commands, null)).toBe(commands);
    expect(
      addPlanModeComposerCommand(commands, 'Plan mode').map((command) => command.name),
    ).toEqual(['plan', 'help']);
    expect(addPlanModeComposerCommand(existing, 'Plan mode')).toBe(existing);
  });

  it('removes the selected command token while preserving surrounding draft text', () => {
    const state = stateWithText('Ask first /plan then continue');
    const tr = state.tr;

    expect(consumePlanModeComposerCommand(tr, 11, 16, desktopCommand('plan'), true)).toBe(true);
    expect(tr.doc.textContent).toBe('Ask first  then continue');
  });

  it('does not consume unsupported or non-plan commands', () => {
    const state = stateWithText('/plan');
    const unsupported = state.tr;
    const other = state.tr;

    expect(consumePlanModeComposerCommand(unsupported, 1, 6, desktopCommand('plan'), false)).toBe(
      false,
    );
    expect(unsupported.doc.textContent).toBe('/plan');
    expect(consumePlanModeComposerCommand(other, 1, 6, desktopCommand('help'), true)).toBe(false);
    expect(other.doc.textContent).toBe('/plan');
  });

  it('recognizes only an available standalone plan command on send', () => {
    expect(isPlanModeComposerCommandText('/plan', true, [])).toBe(true);
    expect(isPlanModeComposerCommandText('  /PLAN  ', true, [])).toBe(true);
    expect(isPlanModeComposerCommandText('/plan explain this', true, [])).toBe(false);
    expect(isPlanModeComposerCommandText('/plan', false, [])).toBe(false);
    expect(isPlanModeComposerCommandText('/plan', true, null)).toBe(false);
    expect(
      isPlanModeComposerCommandText('/plan', true, [
        { kind: 'agent-skill', name: 'PLAN', source: 'skill' },
      ]),
    ).toBe(false);
  });

  it('preserves supplementary draft content when consuming plan mode', () => {
    expect(shouldPreservePlanModeComposerDraft(1, 0)).toBe(true);
    expect(shouldPreservePlanModeComposerDraft(0, 1)).toBe(true);
    expect(shouldPreservePlanModeComposerDraft(0, 0)).toBe(false);
  });

  it('captures editor text before the plan command clears the editor', () => {
    const editorText = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep me' }] }],
    };
    const storedText = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'stored' }] }],
    };

    expect(planModeComposerDraftText(true, editorText, storedText)).toBe(editorText);
    expect(planModeComposerDraftText(false, null, storedText)).toBe(storedText);
    expect(planModeComposerDraftText(true, null, storedText)).toBeNull();
    expect(planModeComposerDraftText(true, editorText, storedText, true)).toBeNull();
  });

  it('does not persist the consumed /plan command as draft text', () => {
    const editorText = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '/plan' }] }] };
    expect(planModeComposerDraftText(true, editorText, null, true)).toBeNull();
    expect(planModeComposerDraftText(false, null, editorText, true)).toBeNull();
  });
});
