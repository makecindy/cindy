import { describe, expect, it } from 'vitest';
import { PLUGIN_UI_MAX_BYTES, parsePluginUiContent, parsePluginUiView, parsePluginUiViews, parsePluginUiScope,
  parsePluginUiActionResult, parsePluginUiInvokeInput, parsePluginUiInvocationResult, pluginUiPointAcceptsScope } from './pluginUi.js';
import type { PluginUiContent } from './pluginUiPublic.js';

/* Test value: C2/C3 portable production parsers must reject forged bindings,
 * unbound actions, unsupported required input, and ambiguous business outcomes.
 * Existing card/rich-answer tests do not exercise this independent contract.
 * Minimal inputs are a single action/control or an invalid scope. Tier: unit. */
const content: PluginUiContent = {
  controls: [{ kind: 'select', id: 'format', label: 'Format', value: 'plain',
    actionId: 'set-format', options: [{ value: 'plain', label: 'Plain' }] }],
  blocks: [{ kind: 'markdown', id: 'hint', text: 'Preview' }],
  actions: [{ id: 'set-format', label: 'Change format' }], fallbackMarkdown: 'Format: Plain',
};

describe('native plugin UI contracts', () => {
  // Self-drawn pages need their own structured request/result, not only a status.
  // Unit: production parsers previously discarded data. Minimum: one nested item.
  it('preserves JSON business data without interpreting it as Host metadata', () => {
    const data = { items: [{ id: 'one', value: null }], state: { selected: true }, revision: 2 };
    const request = { viewId: 'host-view', expectedRevision: '1', invocationId: 'click', actionId: 'load', values: {}, data };
    const result = { status: 'completed', data };
    expect(parsePluginUiInvokeInput(request)).toEqual(request);
    expect(parsePluginUiActionResult(result)).toEqual(result);
    expect(parsePluginUiInvocationResult({ ...result, invocationId: 'click' })).toEqual({ ...result, invocationId: 'click' });
    expect(parsePluginUiActionResult({ status: 'completed', data: null })).toEqual({ status: 'completed', data: null });
    for (const invalid of [{ callback: () => {} }, { number: Infinity }, { field: undefined }, { text: 'x'.repeat(PLUGIN_UI_MAX_BYTES) }]) {
      expect(parsePluginUiInvokeInput({ ...request, data: invalid })).toBeNull();
      expect(parsePluginUiActionResult({ ...result, data: invalid })).toBeNull();
    }
  });
  // 4.1: author navigation is data, not a Host destination. Unknown outcomes
  // must not carry an open request. No existing edit test covers this. Tier: unit.
  it('keeps bounded navigation only on a successful action and strips forged destinations', () => {
    const openView = { id: 'build-log', params: { buildId: 'b1' } };
    expect(parsePluginUiActionResult({ status: 'completed', openView: { ...openView, windowId: 9 } }))
      .toEqual({ status: 'completed', openView });
    expect(parsePluginUiActionResult({ status: 'outcome-unknown', openView })).toBeNull();
    expect(parsePluginUiActionResult({ status: 'completed', openView: { id: '../page.html' } })).toBeNull();
    expect(parsePluginUiActionResult({ status: 'completed', openView: { ...openView, params: { bad: {} } } })).toBeNull();
  });
  it('accepts author content while discarding Host-owned and unknown metadata', () => {
    expect(parsePluginUiContent({ ...content, viewId: 'forged', revision: '999', page: { surface: 'ui' } }))
      .toEqual(content);
  });
  it('requires real Host metadata for a projected view', () => {
    expect(parsePluginUiView(content)).toBeNull();
    const view = { ...content, version: 1, viewId: 'host-1', contributionId: 'format',
      point: 'composer.tools', revision: '1' };
    expect(parsePluginUiView(view)).toEqual(view);
    expect(parsePluginUiView({ ...view, version: 2 })).toBeNull();
  });
  it('accepts only the host page flag, never a page path supplied in a projection', () => {
    const view = { ...content, version: 1, viewId: 'host-1', contributionId: 'format',
      point: 'composer.tools', revision: '1', page: true };
    expect(parsePluginUiView(view)).toEqual(view);
    expect(parsePluginUiView({ ...view, page: 'https://example.com' })).toBeNull();
  });
  it('keeps a host-issued command shortcut id and rejects an invalid one', () => {
    const view = { ...content, version: 1, viewId: 'host-1', contributionId: 'format',
      point: 'composer.tools', revision: '1', command: { shortcutId: `plugin:${'a'.repeat(64)}` } };
    expect(parsePluginUiView(view)).toEqual(view);
    expect(parsePluginUiView({ ...view, command: { shortcutId: 'other' } })).toBeNull();
  });
  it('keeps the full author content budget after Host metadata is added', () => {
    const empty = { controls: [], blocks: [], actions: [], fallbackMarkdown: '' };
    const full = { ...empty, fallbackMarkdown: 'x'.repeat(PLUGIN_UI_MAX_BYTES - JSON.stringify(empty).length) };
    expect(parsePluginUiContent(full)).toEqual(full);
    const view = { ...full, version: 1, viewId: 'host', contributionId: 'format', point: 'composer.tools', revision: '1' };
    expect(parsePluginUiView(view)).toEqual(view);
    expect(parsePluginUiViews(Array.from({ length: 9 }, (_, i) => ({ ...view, viewId: String(i) })))).toBeNull();
  });
  it.each([
    { ...content, actions: [] },
    { ...content, controls: [content.controls[0], content.controls[0]] },
    { ...content, controls: [{ ...content.controls[0], value: 'undeclared' }] },
    { ...content, fallbackMarkdown: 'x'.repeat(33_000) },
    { ...content, blocks: [{ kind: 'html', id: 'html', text: '<script>bad()</script>' }] },
  ])('rejects unbound actions, duplicate controls and content outside the finite model', (value) => {
    expect(parsePluginUiContent(value)).toBeNull();
  });
  it('keeps a readable fallback and removes actions when required controls are unsupported', () => {
    expect(parsePluginUiContent({ ...content, controls: [
      ...content.controls, { kind: 'future.secret', id: 'required', label: 'Unknown', required: true },
    ] })).toEqual({ ...content, controls: [], actions: [] });
  });
  it('does not turn unknown or mismatched object scopes into task access', () => {
    expect(parsePluginUiScope({ kind: 'app' })).toBeNull();
    expect(parsePluginUiScope({ kind: 'app', sessionId: 's' })).toBeNull();
    expect(parsePluginUiScope({ kind: 'session', sessionId: 's' })).toEqual({ kind: 'session', sessionId: 's' });
    expect(parsePluginUiScope({ kind: 'message', sessionId: 's', messageClientId: 'm' }))
      .toEqual({ kind: 'message', sessionId: 's', messageClientId: 'm' });
    expect(parsePluginUiScope({ kind: 'tool', sessionId: 's' })).toBeNull();
    expect(parsePluginUiScope({ kind: 'future', sessionId: 's' })).toBeNull();
    expect(pluginUiPointAcceptsScope('composer.tools', 'session')).toBe(true);
    expect(pluginUiPointAcceptsScope('composer.tools', 'message')).toBe(false);
    expect(pluginUiPointAcceptsScope('app.edge.left', 'app')).toBe(false);
    expect(pluginUiPointAcceptsScope('app.edge.left', 'session')).toBe(false);
    expect(pluginUiPointAcceptsScope('future.point', 'session')).toBe(false);
  });
  it('accepts exactly one business terminal outcome and forbids effects on unknown results', () => {
    for (const status of ['completed', 'rejected', 'outcome-unknown']) {
      expect(parsePluginUiActionResult({ status })).toEqual({ status });
    }
    expect(parsePluginUiActionResult({ status: 'accepted' })).toBeNull();
    expect(parsePluginUiActionResult({ status: 'outcome-unknown', effects: [{ kind: 'composer-edit' }] })).toBeNull();
    expect(parsePluginUiActionResult({ status: 'outcome-unknown', edit: { operation: 'append', text: 'late' } })).toBeNull();
    expect(parsePluginUiActionResult({ status: 'completed', edit: { operation: 'append', text: 'text', draftKey: 'forged' } }))
      .toEqual({ status: 'completed', edit: { operation: 'append', text: 'text' } });
  });
});
