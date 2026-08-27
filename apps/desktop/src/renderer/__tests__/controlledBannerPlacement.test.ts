import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const R = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(R, rel), 'utf8').replace(/\r\n?/g, '\n');

const sessionViewSource = read('features/cc-agent/CCAgentSessionView.tsx');
const splitViewSource = read('features/cc-agent/OrcaSplitView.tsx');
const routeSource = read('features/cc-agent/OrcaWorkflowRoute.tsx');
const workerPanelSource = read('features/cc-agent/OrcaWorkerPanel.tsx');
const mainLayoutSource = read('components/layout/MainLayout.tsx');
const controlledBannerSource = read('features/remote-device/ControlledBanner.tsx');
const pinnedPlanSource = read('components/new-chat/PinnedPlanPanel.tsx');
const todoListSource = read('components/chat/TodoListCard.tsx');

describe('controlled banner placement', () => {
  it('switches the controlled banner between the centered group and token metadata', () => {
    expect(sessionViewSource).toContain('showControlledBanner?: boolean;');
    expect(sessionViewSource).toContain('showControlledBanner = false');
    expect(sessionViewSource).toContain(
      'const showComposerControlledBanner = ownsRoute || showControlledBanner;',
    );
    expect(sessionViewSource).toContain(
      'const hasControlledBanner = showComposerControlledBanner && controlledBy.length > 0;',
    );
    expect(sessionViewSource).toContain(
      'const controlledBannerCollapsed = useComposerCollapsed(sessionId ?? null);',
    );
    expect(sessionViewSource).toContain(
      'const showExpandedControlledBanner = hasControlledBanner && !controlledBannerCollapsed;',
    );
    expect(sessionViewSource).toContain('placement="composer"');
    expect(sessionViewSource).toContain('sessionId={sessionId ?? null}');
    expect(sessionViewSource).toContain('rightLeadingSlot={');
    expect(sessionViewSource).toContain('hasControlledBanner && controlledBannerCollapsed ? (');
    expect(sessionViewSource).toContain(
      '{(!pendingPlanReview || (hasControlledBanner && controlledBannerCollapsed)) && (',
    );
    expect(sessionViewSource).toContain('suppressContent={Boolean(pendingPlanReview)}');
    expect(sessionViewSource).toContain(
      'const isHidden = suppressContent || (!showContent && !visible);',
    );
    expect(sessionViewSource).toContain('{showExpandedControlledBanner && (');
    expect(sessionViewSource).toContain('rightLeadingSlot?: ReactNode;');
    expect(sessionViewSource).toContain('{rightLeadingSlot}');
    expect(sessionViewSource).toContain('data-running-status-meta="true"');
    expect(sessionViewSource).not.toContain('className="mx-auto flex h-9 shrink-0 items-center"');
  });

  it('keeps only the collapsed breathing light anchored before token metadata', () => {
    expect(sessionViewSource).toContain('const CONTROLLED_BANNER_MAX_WIDTH = 420;');
    expect(sessionViewSource).toContain(
      'const controlledBannerMaxWidth = `min(${inputHalfWidth}, ${CONTROLLED_BANNER_MAX_WIDTH}px)`;',
    );
    expect(sessionViewSource).toContain('if (isHidden && !rightLeadingSlot) return null;');
    expect(controlledBannerSource).toContain("placement?: 'floating' | 'inline' | 'composer';");
    expect(controlledBannerSource).toContain(
      'className="pointer-events-auto flex min-w-0 max-w-full shrink justify-end"',
    );
    expect(controlledBannerSource).not.toContain(
      'className="pointer-events-auto flex max-w-full shrink-0 -translate-y-0.5 justify-end"',
    );
    expect(controlledBannerSource).toContain(
      'className="session-status-breathing h-1.5 w-1.5 rounded-full"',
    );
    expect(controlledBannerSource).toContain(
      'const collapsedComposerSessionIds = new Set<string>();',
    );
    expect(controlledBannerSource).toContain(
      'export function useComposerCollapsed(sessionId: string | null): boolean',
    );
    expect(controlledBannerSource).toContain('data-controlled-banner-collapse="true"');
    expect(controlledBannerSource).toContain('data-controlled-banner="collapsed"');
    expect(controlledBannerSource).toContain('data-controlled-banner-chip="true"');
    expect(controlledBannerSource).toContain(
      "'pointer-events-auto flex h-7 min-w-0 max-w-full select-none items-center gap-2 overflow-hidden rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-0',",
    );
    expect(sessionViewSource).toContain(
      'className="flex min-w-0 items-center justify-self-end gap-2"',
    );
    expect(sessionViewSource).not.toContain('<div className="-translate-y-0.5">');
    expect(controlledBannerSource).toContain(
      'onClick={() => setComposerCollapsed(composerSessionId, false)}',
    );
    expect(controlledBannerSource).toContain("t('remoteDevice.revokeAccess')");
    expect(sessionViewSource).not.toContain('rightSlot=');
    expect(controlledBannerSource).not.toContain("placement === 'statusbar'");
    expect(sessionViewSource).not.toContain('centerSlot=');
  });

  it('centers the plan and expanded controlled chip as one non-overlapping flex group', () => {
    expect(sessionViewSource.match(/<PinnedPlanPanel/g)).toHaveLength(1);
    expect(sessionViewSource).toContain(
      'className="mx-auto grid grid-cols-1 grid-rows-1 items-center"',
    );
    expect(sessionViewSource).toContain('className="col-start-1 row-start-1"');
    expect(sessionViewSource).toContain('data-composer-center-group="true"');
    expect(sessionViewSource).toContain(
      'className="pointer-events-none relative z-10 col-start-1 row-start-1 flex max-w-full -translate-y-1 items-center justify-center gap-2"',
    );
    expect(sessionViewSource).toContain('className="mb-0"');
    expect(pinnedPlanSource).toContain(
      "cn('mb-1.5 flex h-8 w-auto max-w-full shrink-0 items-center', className)",
    );
    expect(todoListSource).toContain(
      'className="pointer-events-none flex w-auto shrink-0 justify-center"',
    );
    expect(todoListSource).toContain('data-plan-pill-anchor="true"');
    expect(todoListSource).toContain('data-plan-flyout-positioner="composer"');
    expect(sessionViewSource).toContain(
      'const mutationObserver = new MutationObserver(syncResizeTargetsAndMeasure);',
    );
    expect(sessionViewSource).toContain(
      'mutationObserver.observe(overlayEl, { childList: true, subtree: true });',
    );
    expect(sessionViewSource).not.toContain('fitContent=');
    expect(pinnedPlanSource).not.toContain('fitContent');
    expect(todoListSource).not.toContain('fitContent');
  });

  it('caps the right-aligned composer chip without changing the input width', () => {
    expect(controlledBannerSource).toContain("maxWidth?: CSSProperties['maxWidth'];");
    expect(controlledBannerSource).toContain('style={maxWidth == null ? undefined : { maxWidth }}');
    expect(sessionViewSource).toContain('maxWidth={controlledBannerMaxWidth}');
  });

  it('opts in only route-owned chat views, not Worker panes or embedded doc rails', () => {
    expect(sessionViewSource).toContain(
      'const showComposerControlledBanner = ownsRoute || showControlledBanner;',
    );
    expect(routeSource).not.toContain('<CCAgentSessionView');
    expect(routeSource).not.toContain('showControlledBanner');
    expect(splitViewSource).not.toContain('showLeadControlledBanner');
    expect(splitViewSource).not.toContain('showControlledBanner=');

    expect(workerPanelSource).toContain('<CCAgentSessionView');
    expect(workerPanelSource).not.toContain('showControlledBanner');
  });

  it('suppresses the global floating fallback on legacy Orca redirect pages', () => {
    expect(mainLayoutSource).toContain(
      'function hasInlineControlledBannerPath(pathname: string): boolean',
    );
    expect(mainLayoutSource).toContain(
      "return parts.length === 3 && parts[1] === 'orca' && parts[2] !== 'new';",
    );
    expect(mainLayoutSource).toContain('{!hasInlineControlledBanner && <ControlledBanner />}');
  });
});
