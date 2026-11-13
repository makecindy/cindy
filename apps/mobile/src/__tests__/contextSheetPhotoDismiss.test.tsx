// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ContextSheet } from '@/session/ContextSheet.ios';
import { RecentPhotosStrip } from '@/session/ContextSheetMediaViews';

// Regression: selecting a recent photo focused the composer while the native
// sheet was dismissing, leaving a focused WebView without a working keyboard.
// Existing row tests only cover launching pickers, not the shared photo strip.
// Unit tier: real sheet + strip, with native dismissal delivered separately.
const native = vi.hoisted(() => ({ onClosed: undefined as (() => void) | undefined }));
vi.mock('@/session/ContextSheet', async () => import('@/session/ContextSheet.ios'));
vi.mock('@/session/ComposerSheet', () => ({
  ComposerSheet: ({ aboveContent, children, onClosed }: any) => {
    native.onClosed = onClosed;
    return <div>{aboveContent}{children}</div>;
  },
}));
vi.mock('@/session/ComposerNativeSection', () => ({ ComposerNativeSection: () => null }));
vi.mock('@/components/NativeErrorNotice.ios', () => ({ NativeErrorNotice: () => null }));
vi.mock('@/platform/chrome/nativeGlassButtonStyle.ios', () => ({ useNativeGlassButtonStyle: () => [] }));
vi.mock('@expo/ui/swift-ui', () => ({}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled, testID }: any) =>
    <button disabled={disabled} onClick={onPress} data-testid={testID}>{children}</button>,
  ActivityIndicator: () => null,
}));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('lucide-react-native', () => ({ Check: () => null }));
vi.mock('@/components/AppText', () => ({ Text: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({
  fontWeight: {}, iconSize: {}, iconStroke: {}, lineHeight: {}, radius: {}, spacing: {}, typeScale: {},
  useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}),
}));
vi.mock('@/session/useContextSheetMediaAssets', () => ({
  useContextSheetMediaAssets: () => ({ status: 'ready', assets: [
    { id: 'screenshot', uri: 'ph://screenshot', filename: 'screen.png' },
    { id: 'other', uri: 'ph://other', filename: 'other.png' },
  ] }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

function mount(onToggleAsset: React.ComponentProps<typeof RecentPhotosStrip>['onToggleAsset']) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const events: string[] = [];
  const render = (visible: boolean) => act(() => root.render(
    <ContextSheet visible={visible} onClose={() => events.push('close')} title="Attachments"
      keyboardAvoidingBehavior={undefined}
      media={<RecentPhotosStrip enabled={visible} selectedAssetIds={new Set()}
        onToggleAsset={onToggleAsset} />}>
      {null}
    </ContextSheet>,
  ));
  render(true);
  cleanups.push(() => act(() => root.unmount()));
  return { events, render, select: (index = 0) => act(() => (host.querySelectorAll('button')[index] as HTMLButtonElement).click()) };
}

// Execute the task page's production callback, as the composer lifecycle tests do,
// without importing the entire network/native task screen. The focus double models
// the observed iOS state: an already focused editor cannot reopen its hidden keyboard.
const page = ts.createSourceFile('session.tsx', readFileSync('app/sessions/[sessionId].tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let selectPhotoCode = '';
function findSelection(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(page) === 'toggleMediaAssetAttachment'
    && node.initializer && ts.isCallExpression(node.initializer)) {
    selectPhotoCode = ts.transpileModule('const select = ' + node.initializer.arguments[0].getText(page), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  ts.forEachChild(node, findSelection);
}
findSelection(page);

function setup(pendingCount = 0) {
  let focused = true;
  let keyboardVisible = false;
  const frames: (() => void)[] = [];
  const bindings = {
    mediaTapAcceptedRef: { current: false }, mediaAssetAttachments: {}, uploadingMediaAssetIds: new Set(),
    attachments: [], getPendingUploadCount: () => pendingCount, MOBILE_MAX_ATTACHMENTS: 20, t: (key: string) => key,
    setAttachmentError: vi.fn(), enqueueUploads: vi.fn(), auth: { getAccessToken: () => 'mock' },
    setContextSheetOpen: vi.fn(), requestAnimationFrame: (callback: () => void) => frames.push(callback),
    composerInputRef: { current: {
      blur: vi.fn(() => { focused = false; }),
      focus: () => { if (!focused) keyboardVisible = true; focused = true; },
    } },
  };
  const select = new Function(...Object.keys(bindings), selectPhotoCode + '\nreturn select;')(...Object.values(bindings));
  return { ...mount(select), bindings, frames, keyboardVisible: () => keyboardVisible,
    finishFrame: () => act(() => frames.splice(0).forEach(frame => frame())) };
}

it('enqueues immediately and restores typing only after native dismissal, clearing stale focus', () => {
  const screen = setup();
  screen.select();
  expect(screen.bindings.enqueueUploads).toHaveBeenCalledTimes(1);
  expect(screen.events).toEqual(['close']);
  expect(screen.frames).toHaveLength(0);
  screen.render(false);
  expect(screen.bindings.composerInputRef.current.blur).not.toHaveBeenCalled();
  act(() => native.onClosed?.());
  screen.finishFrame();
  expect(screen.keyboardVisible()).toBe(true);
  act(() => native.onClosed?.());
  expect(screen.bindings.composerInputRef.current.blur).toHaveBeenCalledTimes(1);
});

it('does not steal focus if the sheet reopens before dismissal', () => {
  const screen = setup();
  screen.select();
  screen.render(false);
  screen.render(true);
  act(() => native.onClosed?.());
  screen.finishFrame();
  expect(screen.keyboardVisible()).toBe(false);
  expect(screen.bindings.composerInputRef.current.blur).not.toHaveBeenCalled();
});

it('keeps the first photo when another thumbnail is tapped during dismissal', () => {
  const screen = setup();
  screen.select();
  screen.select(1);
  expect(screen.bindings.enqueueUploads).toHaveBeenCalledExactlyOnceWith(
    [expect.objectContaining({ sourceId: 'screenshot' })], expect.anything());
  expect(screen.events).toEqual(['close']);
});

it('keeps the sheet open and shows the limit error when no attachment slot remains', () => {
  const screen = setup(20);
  screen.select();
  expect(screen.events).toEqual([]);
  expect(screen.bindings.setAttachmentError).toHaveBeenCalledWith('session.common.maxAttachments');
  expect(screen.bindings.enqueueUploads).not.toHaveBeenCalled();
});
