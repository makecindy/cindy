import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import ts from 'typescript';
import { i18n } from '@/i18n';
import { logUnhandledRenderItem } from '@/session/assertNever';
import { useFoldableExpandedState } from '@/session/expandedBlockMemory';
import { buildMessageHierarchyLayout } from '@/session/messageHierarchyLayout';
import { formatLocalizedDuration } from '@/session/sessionDurationFormat';
import { iconSize, iconStroke, lightColors } from '@/theme/tokens';

// Run the actual internal components without loading the native message-list
// host or unrelated viewers. Only native view surfaces and unrelated children
// are adapted; routing, folding, account/device keys, and React hooks stay real.
export const rendererSource = ts.createSourceFile('MessageRenderer.tsx', readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
export function rendererFunction(name: string): ts.FunctionDeclaration | ts.FunctionExpression {
  let found: ts.FunctionDeclaration | ts.FunctionExpression | undefined;
  function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(rendererSource);
  if (!found?.body) throw new Error('Message renderer function was not found: ' + name);
  return found;
}

export function executeRenderer<T>(code: string, globals: Record<string, unknown>): T {
  const emitted = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const bindings = { React, ...globals };
  return new Function(...Object.keys(bindings), emitted)(...Object.values(bindings));
}

type NativeProps = { children?: React.ReactNode; testID?: string; onPress?: () => void; expanded?: boolean; accessibilityLabel?: string; style?: unknown };
function View({ children, testID, style }: NativeProps) {
  return React.createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(style) }, children);
}
function Text({ children, testID, onPress }: NativeProps) {
  return React.createElement(onPress ? 'button' : 'span', { 'data-testid': testID, onClick: onPress }, children);
}
function Header({ children, testID, onPress, expanded, accessibilityLabel, style }: NativeProps) {
  return React.createElement('button', { 'data-testid': testID, onClick: onPress, 'aria-expanded': expanded, 'aria-label': accessibilityLabel, 'data-style': JSON.stringify(style) }, children);
}

export function collaborationRenderer() {
  const state = { accountGeneration: 1 };
  const declarations = ['RenderItemView', 'SubagentCard', 'CollabCardShell', 'FoldablePanel', 'Rail', 'OrcaCollabCard', 'agentTaskStatusLabel']
    .map(name => rendererFunction(name).getText(rendererSource)).join(String.fromCharCode(10));
  const bindings = { useMemo: React.useMemo, useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback, useTranslation, i18n, View, Text, useTheme: () => ({ colors: lightColors }),
    useThemedStyles: () => ({}), makeStyles: () => ({}),
    useAuth: () => ({ accountGeneration: state.accountGeneration }),
    useRecyclingState: React.useState, useFoldableExpandedState,
    buildMessageHierarchyLayout, formatLocalizedDuration, iconSize, iconStroke,
    Bot: () => null, ChevronDown: () => null, ChevronRight: () => null,
    FoldableHeaderButton: Header, logUnhandledRenderItem,
    MessageBubble: ({ item }: { item: { message: { body: string } } }) => React.createElement('span', null, item.message.body),
  };
  return { state, ...executeRenderer<Record<'RenderItemView' | 'SubagentCard' | 'OrcaCollabCard', React.ComponentType<any>>>(declarations
    + '; return { RenderItemView, SubagentCard, OrcaCollabCard };', bindings) };
}
