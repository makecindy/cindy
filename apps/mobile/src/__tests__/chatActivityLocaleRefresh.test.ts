// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, memo, useCallback, useMemo, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaults, useTranslation } from 'react-i18next';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import { mobileToolRowWording } from '@/i18n/toolWording';
import { summarizeToolRowPresentation, summarizeWorkGroupPresentation } from '@/session/messagePresentation';

// Exercise the production hooks with a real languageChanged subscription and
// stable props. Importing the whole native message tree would mask these local
// subscriptions behind parent renders and require unrelated native view mocks.
const source = ts.createSourceFile('MessageRenderer.tsx', readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function component(name: string): ts.FunctionDeclaration | ts.FunctionExpression {
  let found: ts.FunctionDeclaration | ts.FunctionExpression | undefined;
  function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found?.body) throw new Error('Message component was not found: ' + name);
  return found;
}
function statements(name: string, variables: string[]): string {
  return component(name).body!.statements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => variables.includes(declaration.name.getText(source))
      || declaration.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(source) === 'useTranslation'))
    .map(statement => statement.getText(source)).join(String.fromCharCode(10));
}
function compile(code: string, bindings: Record<string, unknown>): ComponentType<Record<string, unknown>> {
  const emitted = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'createElement' } }).outputText;
  return new Function(...Object.keys(bindings), emitted)(...Object.values(bindings));
}
const bindings = { createElement, useTranslation, useMemo, useCallback, mobileToolRowWording, mobilePresentationLocalizer, summarizeToolRowPresentation, summarizeWorkGroupPresentation };
const cards = {
  ToolGroupCard: memo(compile('return function Harness({ actions, item, activity }) {' + statements('ToolGroupCard', ['rowOptions', 'toolRows']) + '; return createElement("output", null, JSON.stringify(toolRows)); };', bindings)),
  WorkGroupCard: memo(compile('return function Harness({ actions, item, activity }) {' + statements('WorkGroupCard', ['presentation']) + '; return createElement("output", null, JSON.stringify(presentation)); };', bindings)),
  WorkToolActivityRow: memo(compile('return function Harness({ actions, item, activity }) {' + statements('WorkToolActivityRow', ['tool', 'row']) + '; return createElement("output", null, JSON.stringify(row)); };', bindings)),
};

const tool = { key: 'tool', kind: 'tool', role: 'tool_use', label: 'Bash', body: '', align: 'agent', source: { toolName: 'Bash', toolInput: { command: 'printf hello' } } };
const item = { key: 'work', type: 'work_group', tools: [tool], children: [], isStreaming: true };
const activity = { key: 'activity', message: { normalized: tool }, status: 'running', intentOverride: undefined };
const props = { actions: { isSessionStreaming: false }, item, activity };
let root: Root;
let host: HTMLDivElement;
let previousLanguage: string;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  previousLanguage = i18n.language;
  await i18n.changeLanguage('en');
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  await i18n.changeLanguage(previousLanguage);
});

describe('message activity wording refreshes with app language', () => {
  it('keeps the default react-i18next languageChanged binding enabled', () => {
    expect(i18n.options.react).toBeUndefined();
    expect(getDefaults().bindI18n).toContain('languageChanged');
  });

  it.each(['ToolGroupCard', 'WorkGroupCard', 'WorkToolActivityRow'] as const)(
    '%s refreshes its cached presentation with no parent or prop change', async name => {
      await act(async () => root.render(createElement(cards[name], props)));
      const initial = host.textContent;
      expect(initial).toContain(name === 'WorkGroupCard' ? i18n.t('chat.workGroup.working') : mobileToolRowWording.verb('runCommand'));
      await act(async () => { await i18n.changeLanguage('zh-CN'); });
      expect(host.textContent).not.toBe(initial);
      expect(host.textContent).toContain(name === 'WorkGroupCard' ? i18n.t('chat.workGroup.working') : mobileToolRowWording.verb('runCommand'));
    },
  );

  it('invalidates completed Markdown blocks when translated fallback labels change', async () => {
    const block = { type: 'paragraph', key: 'paragraph', inlines: [{ type: 'image', url: 'xdt-image://asset', alt: '' }] };
    const Text = ({ children }: { children?: ReactNode }) => createElement('span', null, children);
    const Block = memo(({ render }: { render: (block: unknown, leadingGap: boolean) => ReturnType<typeof createElement> }) => createElement('output', null, render(block, false)));
    const code = component('renderInline').getText(source) + '; return function Harness() {'
      + statements('MarkdownBodyBase', ['renderInlines', 'renderTextRunBlock'])
      + '; return createElement(Block, { render: renderTextRunBlock }); };';
    const Markdown = compile(code, { ...bindings, Block, i18n, Text, MessageBodyText: Text,
      styles: {}, layout: { markdownBodyGap: 0 }, selectable: false, spanFor: () => undefined,
      onOpenSessionLink: undefined, openMarkdownImage: undefined, openMarkdownMedia: undefined,
      renderManagedImage: undefined, sessionLinkTitles: {}, streaming: false,
      isMobileMarkdownImageDirectUrl: () => false, clickableInlineStyle: () => undefined,
    });
    await act(async () => root.render(createElement(Markdown)));
    const initial = host.textContent;
    expect(initial).toBe(i18n.t('message.renderer.imageFallbackTitle'));
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(host.textContent).not.toBe(initial);
    expect(host.textContent).toBe(i18n.t('message.renderer.imageFallbackTitle'));
  });
});
