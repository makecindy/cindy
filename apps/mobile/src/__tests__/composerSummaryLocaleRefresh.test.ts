// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { effortLabelFromRuntime } from '@/session/modelPickerRows';

// Execute the real memo initializer and summary helpers. The old literal check
// could not observe a mounted summary retaining stale labels after locale changes.
function summaryMemo(file: string, name: string, helper: string) {
  const source = ts.createSourceFile(file, readFileSync(resolve(process.cwd(), file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: string | undefined;
  const helpers: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer?.getText(source);
    if (ts.isFunctionDeclaration(node) && [helper, 'choiceLabel'].includes(node.name?.text ?? '')) helpers.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!initializer || helpers.length !== 2) throw new Error('Runtime summary initializer or helper was not found: ' + name);
  const code = ts.transpileModule(helpers.join('\n') + '\nreturn ' + initializer + ';', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('useMemo', 'i18nInstance', 'effortLabelFromRuntime', 'composerDisplaySession', 'composerDisplayRuntimeOptions', 'draft', 'runtimeOptions', code);
}

const sessionSummary = summaryMemo('app/sessions/[sessionId].tsx', 'composerRuntimeSummary', 'buildComposerRuntimeSummary');
const draftSummary = summaryMemo('app/sessions/new.tsx', 'runtimeSummary', 'buildDraftRuntimeSummary');
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

describe('composer summaries refresh with app language', () => {
  it.each([['mounted task', sessionSummary], ['new task draft', draftSummary]] as const)(
    '%s recomputes labels without changing its task or runtime snapshot', async (_surface, summary) => {
      const task = { model: 'Luna', effort: 'xhigh', permissionMode: 'default' };
      const runtime = { currentModel: null, effortOptions: [{ id: 'xhigh', label: 'old snapshot' }], permissionOptions: [{ id: 'default', label: 'Default' }] };
      function Summary() {
        useTranslation();
        const value = summary(useMemo, i18n, effortLabelFromRuntime, task, runtime, task, runtime);
        return createElement('output', null, value.modelSummary);
      }
      await act(async () => root.render(createElement(Summary)));
      expect(host.textContent).toBe('Luna · Extra High');
      await act(async () => { await i18n.changeLanguage('zh-CN'); });
      expect(host.textContent).toBe('Luna · 超高');
    },
  );
});
