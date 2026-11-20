import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { browserWebviewPool } from '../lib/browserWebviewPool';
import { isTabHostedHere } from '../lib/tabHosting';
import { getBucket, subscribe } from '../store';
import type { TabState } from '../types';

export interface TabBodyHostDescriptor {
  tab: TabState;
  sessionId: string | null;
  workdir: string;
  remoteHostId: string | null;
  deviceLinkDeviceId?: string | null;
}

function canHostGuest(tab: TabState): boolean {
  return tab.kind === 'web-browser' || tab.kind === 'file-browser';
}

/**
 * Keep the slots of live browser and file preview guests connected when their task leaves the
 * sidebar. Moving a pooled webview to parking and back recreates its Electron
 * guest, even when the wrapper DOM object itself survives.
 *
 * The pool remains the sole resource budget: retention never acquires or pins
 * a guest. Close, eviction and host handoff remove the corresponding hidden
 * body. File listings and other tabs without a live guest are not retained.
 */
export function useRetainedBrowserTabHosts(
  current: readonly TabBodyHostDescriptor[],
): TabBodyHostDescriptor[] {
  const previous = useRef<readonly TabBodyHostDescriptor[]>([]);
  const [, refresh] = useState(0);

  useEffect(() => {
    const onChange = () => refresh((version) => version + 1);
    const unsubscribeStore = subscribe(onChange);
    const unsubscribeRelease = browserWebviewPool.onRelease(onChange);
    const unsubscribeCreated = browserWebviewPool.onEntryCreated(onChange);
    return () => {
      unsubscribeStore();
      unsubscribeRelease();
      unsubscribeCreated();
    };
  }, []);

  const hosts: TabBodyHostDescriptor[] = [];
  const remaining = new Map(current.map((host) => [host.tab.id, host]));
  for (const host of previous.current) {
    const foreground = remaining.get(host.tab.id);
    if (foreground) {
      hosts.push(foreground);
      remaining.delete(host.tab.id);
      continue;
    }
    // 页签已不由本 renderer 承载(弹出到别的窗口 / 从多页签窗口合并回去):不再保留它的后台 body。
    if (!host.sessionId || !isTabHostedHere(host.tab.id)) continue;
    if (!browserWebviewPool.peek(host.tab.id)) continue;
    // Background navigation/close updates belong to the original task. Never
    // reuse the foreground task's context or revive a tab missing from its bucket.
    const bucket = getBucket(host.sessionId);
    const tab = bucket.hydrated && bucket.tabs.find((candidate) => candidate.id === host.tab.id);
    if (tab && canHostGuest(tab)) hosts.push({ ...host, tab });
  }
  // Stable browser order matters too: React moving an ancestor of a webview
  // within this list disconnects the guest just like reparenting its wrapper.
  hosts.push(...remaining.values());

  useLayoutEffect(() => {
    // Capture current candidates too: their child effects may materialize the
    // guest later in this commit, before the user can switch tasks.
    previous.current = hosts.filter(({ tab }) => canHostGuest(tab));
  });

  return hosts;
}
