import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { readGhostCardSupersededBy } from '@cindy/maker-shared/ghost-card-form';
import {
  ensureSessionCards,
  getGhostCardSnapshot,
  subscribeGhostCards,
  type GhostCardSnapshot,
} from './ghostCardStore';
import { readPrStatusSlotKey } from './ghostCardPrStatus';
import { useInstalledGhosts } from './useInstalledGhosts';
import { findInstalledGhostByInstanceId } from '../../shared/pluginIdentity';

/** Only cards belonging to this task may operate its follow-up. Never borrow another task's card. */
export function findSessionPrCard(snapshot: GhostCardSnapshot, sessionId: string, prKey: string) {
  let match: { callId: string; ghostId: string; html: string } | null = null;
  for (const [callId, entry] of snapshot.byCallId) {
    if (
      entry.status !== 'ready' ||
      entry.sessionId !== sessionId ||
      `github:github.com/${readPrStatusSlotKey(entry.html)}` !== prKey ||
      readGhostCardSupersededBy(entry.html)
    )
      continue;
    match = { callId, ghostId: entry.ghostId, html: entry.html };
  }
  if (!match) return null;
  return { ...match, ...projectPrCard(match.html) };
}

/** Present existing plugin controls without nesting its complete chat card. The
 * original action attributes and call identity remain owned by the card bridge. */
export function projectPrCard(html: string) {
  const container = document.createElement('div');
  container.innerHTML = html;
  const styles = [...container.querySelectorAll('style')].map((el) => el.outerHTML).join('');
  const gear = container.querySelector<HTMLButtonElement>(
    'button[data-ghost-action="prui:settings"]',
  );
  const settingsPanel = container.querySelector('[data-ghost-action^="prset:"]')?.parentElement;
  const heading = settingsPanel?.firstElementChild;
  const settingsLabel =
    heading?.textContent || gear?.getAttribute('aria-label') || gear?.textContent || null;
  const actions = [
    ...container.querySelectorAll<HTMLDivElement>('div[data-ghost-pr-open-only]'),
  ].find(
    (el) =>
      !el.querySelector('[data-ghost-action^="prset:"]') &&
      (el.querySelector('[data-ghost-action^="pr:"]') || el.style.marginLeft === 'auto'),
  );
  let summaryHtml: string | null = null;
  if (actions) {
    actions.classList.add('pr-summary-actions');
    actions.style.marginLeft = '0';
    actions.style.minHeight = '32px';
    actions.style.justifyContent = 'space-between';
    const live = actions.querySelector('[data-ghost-live-label]');
    if (live) actions.prepend(live);
    // Keep the stop control in the tab order and reserve its space while hidden.
    // The original chat card's selectors target its outer wrapper, absent here.
    summaryHtml =
      styles +
      `<style>
      .pr-summary-actions>button[data-ghost-action="pr:stop"]{opacity:0;visibility:visible;pointer-events:none}
      .pr-summary-actions:hover>button[data-ghost-action="pr:stop"],
      .pr-summary-actions:focus-within>button[data-ghost-action="pr:stop"]{opacity:1;pointer-events:auto;transition-delay:0s}
      button[data-ghost-action="prui:settings"]{display:none!important}
    </style>` +
      actions.outerHTML +
      (gear?.outerHTML ?? '');
  } else {
    // Another task follows this PR: this task's card is a read-only reference whose
    // only control is the link to that task. Show the same state and link here.
    const taskLink = container.querySelector<HTMLButtonElement>(
      'button[data-ghost-action="pr:open-task"]',
    );
    if (taskLink) {
      let card: Element = taskLink;
      while (card.parentElement && card.parentElement !== container) card = card.parentElement;
      // The card header ends with its state, after the last separator of the meta line.
      const state = [...(card.firstElementChild?.querySelectorAll('span') ?? [])]
        .map((separator) => separator.nextSibling)
        .filter((node) => node?.nodeType === Node.TEXT_NODE && node.textContent?.trim())
        .pop()
        ?.textContent?.trim();
      const row = document.createElement('div');
      row.className = 'pr-summary-actions';
      row.style.cssText =
        'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;min-height:32px';
      if (state) {
        const label = document.createElement('div');
        label.style.cssText = 'padding:0 4px;font-size:13px;color:var(--text-secondary)';
        label.textContent = state;
        row.append(label);
      }
      row.append(taskLink);
      summaryHtml = styles + row.outerHTML;
    }
  }
  let settingsHtml: string | null = null;
  if (settingsPanel) {
    heading?.remove();
    settingsPanel.style.borderTop = '0';
    settingsPanel.style.padding = '0';
    const modelRow = settingsPanel.querySelector('[data-ghost-action="prset:model"]')?.parentElement
      ?.parentElement;
    if (modelRow) {
      modelRow.style.flexWrap = 'wrap';
      modelRow.style.gap = '12px';
    }
    settingsHtml = styles + settingsPanel.outerHTML;
  }
  return { summaryHtml, settingsHtml, settingsLabel };
}

export function useSessionPrCard(sessionId: string, prKey: string, enabled: boolean) {
  const snapshot = useSyncExternalStore(subscribeGhostCards, getGhostCardSnapshot);
  useEffect(() => {
    if (enabled) ensureSessionCards(sessionId);
  }, [enabled, sessionId]);
  const ghosts = useInstalledGhosts(enabled);
  return useMemo(() => {
    if (!enabled) return null;
    const card = findSessionPrCard(snapshot, sessionId, prKey);
    if (!card?.summaryHtml) return null;
    const ghost = findInstalledGhostByInstanceId(ghosts, card.ghostId);
    return ghost?.enabled && ghost.approval.state === 'approved' ? card : null;
  }, [snapshot, sessionId, prKey, enabled, ghosts]);
}
