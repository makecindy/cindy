// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTINUE_AFTER_ERROR_PROMPT } from '@cindy/maker-shared/synthetic-trigger';
import { i18n } from '@/i18n';
import { __test_internals as expansion } from '@/session/expandedBlockMemory';
import { collectMobileMessageGalleryImages } from '@/session/messageGallery';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import { buildMobileMessageRenderItems, type MobileSubagentGroupItem } from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';
import { collaborationRenderer } from './fixtures/messageRendererComponents';

const renderer = collaborationRenderer();
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage('en');
  expansion.reset();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); expansion.reset(); });
const message = (id: string, role: string, content: unknown, rest: Record<string, unknown> = {}): RemoteMessage => ({ id, clientId: id, role, content, sessionId: 'task', toolUseId: null, agentMeta: null, createdAt: '2026-01-01T00:00:00Z', ...rest } as RemoteMessage);
function group(key: string, childItems: MobileSubagentGroupItem['childItems'] = []): MobileSubagentGroupItem {
  return { type: 'subagent_group', key, header: { description: key, subagentType: 'research' }, childItems, summary: key + ' summary', status: 'running' };
}
function click(selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error('Collaboration toggle was not found: ' + selector);
  act(() => button.click());
}

describe('subagent nesting render behavior', () => {
  it('dispatches nested subagents through collapsed cards, revealing children and summaries on demand', () => {
    const [normalized] = normalizeRemoteMessages([message('child', 'assistant', 'Nested response')]);
    const child = group('child-group', [{ type: 'message', key: 'leaf', message: normalized }]);
    act(() => root.render(createElement(renderer.RenderItemView, { item: group('parent-group', [child]), actions: { screenWidth: 320 } })));
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('parent-group summary');
    click('[data-testid="message.subagentToggle"]');
    expect(host.textContent).toContain('parent-group summary');
    expect(host.textContent).not.toContain('Nested response');
    const buttons = host.querySelectorAll<HTMLButtonElement>('[data-testid="message.subagentToggle"]');
    act(() => buttons[1].click());
    expect(host.textContent).toContain('Nested response');
    expect(host.textContent).toContain('child-group summary');
  });

  it('logs and skips unknown render variants in both the row and gallery without throwing', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unknown = { type: 'future-variant', key: 'future' } as never;
    expect(() => act(() => root.render(createElement(renderer.RenderItemView, { item: unknown, actions: {} })))).not.toThrow();
    expect(host.textContent).toBe('');
    expect(collectMobileMessageGalleryImages([unknown])).toEqual([]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.every(call => call[1] === unknown)).toBe(true);
  });

  it('uses a static Orca header for an empty body and responsive fold controls for a populated body', () => {
    act(() => root.render(createElement(renderer.OrcaCollabCard, { card: { variant: 'dispatch', title: 'Dispatch', body: '  ' }, screenWidth: 320, blockKey: 'empty' })));
    expect(host.textContent).toBe('Dispatch');
    expect(host.querySelector('button')).toBeNull();
    act(() => root.render(createElement(renderer.OrcaCollabCard, { card: { variant: 'dispatch', title: 'Dispatch', body: 'Body' }, screenWidth: 320, blockKey: 'body' })));
    const compact = host.querySelector('button')!.getAttribute('data-style');
    expect(host.textContent).not.toContain('Body');
    click('[data-testid="message.orcaCard.dispatch"]');
    expect(host.querySelector('[data-testid="message.orcaCardBody"]')?.textContent).toBe('Body');
    act(() => root.render(createElement(renderer.OrcaCollabCard, { card: { variant: 'dispatch', title: 'Dispatch', body: 'Body' }, screenWidth: 800, blockKey: 'body' })));
    expect(host.querySelector('button')!.getAttribute('data-style')).not.toBe(compact);
  });

  it('restores a manually expanded subagent after remounting the shared fold controls', () => {
    const item = group('remembered');
    const show = () => createElement(renderer.SubagentCard, { item, actions: { screenWidth: 402 } });
    act(() => root.render(show()));
    click('[data-testid="message.subagentToggle"]');
    expect(host.textContent).toContain('remembered summary');
    act(() => root.render(null));
    act(() => root.render(show()));
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('remembered summary');
  });

  it('groups actual parentUuid messages and keeps normal messages while hiding synthetic resume input', () => {
    const messages = [
      message('user', 'user', 'Start'),
      message('agent', 'tool_use', { toolName: 'Agent', toolUseId: 'agent-call', input: { description: 'Research' } }, { toolUseId: 'agent-call' }),
      message('child', 'assistant', 'Research result', { agentMeta: { parentUuid: 'agent-call' } }),
      message('result', 'tool_result', 'Research summary', { toolUseId: 'agent-call' }),
      message('resume', 'user', CONTINUE_AFTER_ERROR_PROMPT, { agentMeta: { autoResume: true } }),
    ];
    const items = buildMobileMessageRenderItems(messages, {});
    const nested = items.find(item => item.type === 'subagent_group');
    expect(nested).toMatchObject({ type: 'subagent_group', summary: 'Research summary' });
    expect(items.some(item => item.type === 'message' && item.message.body === 'Start')).toBe(true);
    expect(items.some(item => item.type === 'message' && item.message.body === CONTINUE_AFTER_ERROR_PROMPT)).toBe(false);
    expect(nested?.type === 'subagent_group' && nested.childItems.length).toBeGreaterThan(0);
  });
});
