// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ContextSheet } from '@/session/ContextSheet.ios';
import { ContextSheetMediaAddButton, useContextSheetMediaSelection } from '@/session/ContextSheetMediaSelection';
import { RecentPhotosStrip } from '@/session/ContextSheetMediaViews';
import { contextSheetMediaUploadCandidates } from '@/session/contextSheetMediaUpload';

// Regression: selecting a recent photo focused the composer while the native
// sheet was dismissing, leaving a focused WebView without a working keyboard.
// Existing row tests only cover launching pickers, not the shared photo strip.
// Unit tier: real sheet + strip, with native dismissal delivered separately.
//
// Selection circles (user request, 2026-11-16; rule in ios-native-design.md §6): a circle picks
// several photos, which wait for the sheet's bottom button; a tap on a photo still adds that
// one at once. The earlier cases only tap photos, so adding the picked batch, discarding it
// on close and the attachment limit while picking were uncovered.
const native = vi.hoisted(() => ({ onClosed: undefined as (() => void) | undefined }));
vi.mock('@/session/ContextSheet', async () => import('@/session/ContextSheet.ios'));
vi.mock('@/session/ComposerSheet', () => ({
  ComposerSheet: ({ aboveContent, children, footer, onClosed }: any) => {
    native.onClosed = onClosed;
    return <div>{aboveContent}{children}{footer}</div>;
  },
}));
vi.mock('@/session/ComposerNativeSection', () => ({ ComposerNativeSection: () => null }));
vi.mock('@/components/NativeErrorNotice.ios', () => ({ NativeErrorNotice: () => null }));
vi.mock('@/platform/chrome/nativeGlassButtonStyle.ios', () => ({ useNativeGlassButtonStyle: () => [] }));
vi.mock('@expo/ui/swift-ui', () => ({
  Button: ({ children, onPress, testID }: any) => <button onClick={onPress} data-testid={testID}>{children}</button>,
  Text: () => null,
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({ disabled: () => null, foregroundStyle: () => null, frame: () => null }));
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
// Only reached when an upload starts, which these cases never do; the real module loads i18n.
vi.mock('@/session/mobileImageAttachment', () => ({ buildMobileImageAttachmentCandidate: vi.fn() }));
vi.mock('@/session/useContextSheetMediaAssets', () => ({
  useContextSheetMediaAssets: () => ({ status: 'ready', assets: [
    { id: 'screenshot', uri: 'ph://screenshot', filename: 'screen.png' },
    { id: 'other', uri: 'ph://other', filename: 'other.png' },
  ] }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

type AddAssets = React.ComponentProps<typeof ContextSheetMediaAddButton>['onAddAssets'];

// The task page's wiring: one selection shared by the strip and the sheet's bottom button.
function Sheet({ visible, addAssets, remainingSlots, onLimitReached, onClose }: {
  visible: boolean; addAssets: AddAssets; remainingSlots: () => number; onLimitReached: () => void; onClose: () => void;
}) {
  const selection = useContextSheetMediaSelection({ open: visible, getRemainingSlots: remainingSlots, onLimitReached });
  return (
    <ContextSheet visible={visible} onClose={onClose} title="Attachments"
      keyboardAvoidingBehavior={undefined}
      footer={selection.assets.length > 0
        ? <ContextSheetMediaAddButton onAddAssets={addAssets} selection={selection} testID="addPhotos" /> : undefined}
      media={<RecentPhotosStrip enabled={visible} selectedAssetIds={new Set()} selection={selection}
        onToggleAsset={(asset, dismiss) => addAssets([asset], dismiss)} />}>
      {null}
    </ContextSheet>
  );
}

function mount(addAssets: AddAssets, remainingSlots: () => number, onLimitReached: () => void) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const events: string[] = [];
  const render = (visible: boolean) => act(() => root.render(
    <Sheet visible={visible} addAssets={addAssets} remainingSlots={remainingSlots}
      onLimitReached={onLimitReached} onClose={() => events.push('close')} />,
  ));
  render(true);
  cleanups.push(() => act(() => root.unmount()));
  const tap = (testID: string) => act(() => (host.querySelector(`[data-testid="${testID}"]`) as HTMLButtonElement).click());
  return {
    events, render,
    select: (id = 'screenshot') => tap(`contextSheet.mediaThumb.${id}`),
    pick: (id: string) => tap(`contextSheet.mediaSelect.${id}`),
    addPicked: () => tap('addPhotos'),
    canAddPicked: () => host.querySelector('[data-testid="addPhotos"]') !== null,
  };
}

// Execute the task page's production callback, as the composer lifecycle tests do,
// without importing the entire network/native task screen. The focus double models
// the observed iOS state: an already focused editor cannot reopen its hidden keyboard.
const page = ts.createSourceFile('session.tsx', readFileSync('app/sessions/[sessionId].tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let selectPhotoCode = '';
function findSelection(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(page) === 'addMediaAssetAttachments'
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
    contextSheetMediaUploadCandidates,
    setAttachmentError: vi.fn(), enqueueUploads: vi.fn(), auth: { getAccessToken: () => 'mock' },
    setContextSheetOpen: vi.fn(), requestAnimationFrame: (callback: () => void) => frames.push(callback),
    composerInputRef: { current: {
      blur: vi.fn(() => { focused = false; }),
      focus: () => { if (!focused) keyboardVisible = true; focused = true; },
    } },
  };
  const select = new Function(...Object.keys(bindings), selectPhotoCode + '\nreturn select;')(...Object.values(bindings));
  const limit = () => bindings.setAttachmentError(bindings.t('session.common.maxAttachments'));
  return { ...mount(select, () => bindings.MOBILE_MAX_ATTACHMENTS - pendingCount, limit),
    bindings, frames, keyboardVisible: () => keyboardVisible,
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
  screen.select('other');
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

it('keeps circle-picked photos in the sheet until its bottom button adds them together', () => {
  const screen = setup();
  screen.pick('other');
  // With photos picked, a tap on a photo picks too instead of adding it alone and dropping them.
  screen.select('screenshot');
  expect(screen.bindings.enqueueUploads).not.toHaveBeenCalled();
  expect(screen.events).toEqual([]);
  screen.addPicked();
  // The picked order travels with the uploads: they run two at a time and may finish in any
  // order, and the tray puts them back by this index (PR #10729 review).
  const [candidates] = screen.bindings.enqueueUploads.mock.calls[0];
  expect(candidates.map((item: any) => [item.sourceId, item.incomingShareOrder.index]))
    .toEqual([['other', 0], ['screenshot', 1]]);
  expect(new Set(candidates.map((item: any) => item.incomingShareOrder.batchId)).size).toBe(1);
  expect(screen.bindings.enqueueUploads).toHaveBeenCalledOnce();
  expect(screen.events).toEqual(['close']);
});

it('drops picked photos when the sheet is closed without adding them', () => {
  const screen = setup();
  screen.pick('other');
  screen.render(false);
  screen.render(true);
  expect(screen.canAddPicked()).toBe(false);
  screen.select('screenshot');
  expect(screen.bindings.enqueueUploads).toHaveBeenCalledExactlyOnceWith(
    [expect.objectContaining({ sourceId: 'screenshot' })], expect.anything());
});

it('stops picking at the last attachment slot and shows the limit error', () => {
  const screen = setup(19);
  screen.pick('screenshot');
  screen.pick('other');
  expect(screen.bindings.setAttachmentError).toHaveBeenLastCalledWith('session.common.maxAttachments');
  screen.addPicked();
  expect(screen.bindings.enqueueUploads).toHaveBeenCalledExactlyOnceWith(
    [expect.objectContaining({ sourceId: 'screenshot' })], expect.anything());
});
