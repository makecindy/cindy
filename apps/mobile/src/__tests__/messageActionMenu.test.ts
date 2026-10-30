// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import ts from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { buildMobileMessageMenu } from '@/session/messageActionMenu';
import { iconSize } from '@/theme/tokens';

// Run the actual component hooks and callbacks; only native sheet animation is
// injected. A click must close first, then dispatch once on the native onClosed.
const sheetSource = ts.createSourceFile('MessageActionSheet.tsx', readFileSync(resolve(process.cwd(), 'src/session/MessageActionSheet.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sheetFunction = sheetSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'MessageActionSheet');
if (!sheetFunction) throw new Error('MessageActionSheet production component is missing');
const sheet = { props: null as any };
const native = ({ children, testID, onPress, disabled }: any) => React.createElement(onPress ? 'button' : 'div', { 'data-testid': testID, onClick: onPress, disabled }, children);
const icon = () => null;
function executeSheet(code: string, bindings: Record<string, unknown>): React.ComponentType<any> {
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const globals = { React, ...bindings };
  return new Function(...Object.keys(globals), compiled)(...Object.values(globals));
}
const ActionSheet = executeSheet(sheetFunction.getText(sheetSource).replace('export function', 'function') + '; return MessageActionSheet;', {
  useCallback: React.useCallback, useEffect: React.useEffect, useRef: React.useRef, useTranslation,
  View: native, Text: native, Pressable: native,
  useThemedStyles: () => ({}), makeStyles: icon, useTheme: () => ({ colors: {} }),
  useSafeAreaInsets: () => ({ bottom: 0 }), spacing: { md: 16 }, iconSize, iconStroke: { regular: 1.5 },
  BlurBackdrop: icon, ACTION_ICONS: { 'add-to-chat': icon, 'copy-link': icon, rewind: icon, delete: icon },
  SheetModal: (props: any) => { sheet.props = props; return React.createElement('div', null, props.children); },
});

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('mobile message action menu', () => {
  it('matches desktop order, natural language, and destructive grouping', () => {
    expect(buildMobileMessageMenu({
      canAddToChat: true,
      canCopyLink: true,
      canDelete: true,
      canRewind: true,
    })).toEqual([
      { id: 'add-to-chat', label: '添加到对话', image: 'cindy-message-square-plus' },
      { id: 'copy-link', label: '复制当前消息链接', image: 'cindy-link-2' },
      { id: 'rewind', label: '回到此处', image: 'cindy-undo-2' },
      { id: 'delete', label: '删除本条消息', image: 'cindy-trash-2', destructive: true, separatorBefore: true },
    ]);
  });

  it('ships each native menu image as a template at every iOS scale', () => {
    const items = buildMobileMessageMenu({ canAddToChat: true, canCopyLink: true, canDelete: true, canRewind: true });
    for (const item of items) {
      const directory = resolve(process.cwd(), 'assets/message-menu', `${item.image}.imageset`);
      const fingerprintConfig = require('../../fingerprint.config.cjs');
      expect(fingerprintConfig.extraSources).toContainEqual({
        type: 'dir',
        filePath: `assets/message-menu/${item.image}.imageset`,
        reasons: ['native message menu assets'],
      });
      const catalog = JSON.parse(readFileSync(resolve(directory, 'Contents.json'), 'utf8'));
      expect(catalog.properties['template-rendering-intent']).toBe('template');
      expect(catalog.images.map((image: { scale: string }) => image.scale)).toEqual(['1x', '2x', '3x']);
      for (const image of catalog.images) {
        const png = readFileSync(resolve(directory, image.filename));
        const size = iconSize.lg * Number.parseInt(image.scale, 10);
        expect(png.subarray(1, 4).toString()).toBe('PNG');
        expect(png.readUInt32BE(16)).toBe(size);
        expect(png.readUInt32BE(20)).toBe(size);
      }
    }
  });

  it('dispatches once after closing and cancels a stale choice when reopened', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'), root = createRoot(host);
    const onAction = vi.fn(), onClose = vi.fn();
    const props = { items: buildMobileMessageMenu({ canAddToChat: false, canCopyLink: false, canDelete: true, canRewind: true }), onAction, onClose };
    const update = (visible: boolean) => act(() => root.render(React.createElement(ActionSheet, { ...props, visible })));
    try {
      update(true);
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="message.actions.delete"]')!.click());
      expect(onClose).toHaveBeenCalledTimes(1); expect(onAction).not.toHaveBeenCalled();
      update(false); act(() => sheet.props.onClosed()); act(() => sheet.props.onClosed());
      expect(onAction).toHaveBeenCalledExactlyOnceWith('delete');
      onAction.mockClear(); update(true);
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="message.actions.rewind"]')!.click());
      update(false); update(true); update(false); act(() => sheet.props.onClosed());
      expect(onAction).not.toHaveBeenCalled();
      update(true);
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="message.actions.delete"]')!.click());
      act(() => sheet.props.onRequestClose()); update(false); act(() => sheet.props.onClosed());
      expect(onAction).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); }
  });
});
