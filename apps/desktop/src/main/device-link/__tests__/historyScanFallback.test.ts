import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';

// Execute the actual consumer callbacks: a controller-only test cannot prove
// that a timer-driven budget failure refills the raw mirror on both platforms.
function callback(source: string, start: string, end: string, names: string[], values: unknown[]) {
  source = source.replace(/\r\n/g, '\n');
  const from = source.indexOf(start);
  if (from < 0) throw new Error('callback start missing');
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error('callback end missing');
  const body = source.slice(from + start.length, to);
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...names, js)(...values);
}
const desktop = readFileSync(fileURLToPath(new URL('../../../renderer/lib/makerChatStore.ts', import.meta.url)), 'utf8');
const mobile = readFileSync(fileURLToPath(new URL('../../../../../mobile/app/sessions/[sessionId].tsx', import.meta.url)), 'utf8');
describe.each(['\n', '\r\n'])('automatic scan budget fallback owners (%j)', (newline) => {
  const desktopSource = desktop.replace(/\r?\n/g, newline);
  const mobileSource = mobile.replace(/\r?\n/g, newline);
  it.each([true, false])('Desktop refills only the current active view (active=%s)', (active) => {
    const reconcile = vi.fn(async () => true);
    const view = { isActive: () => active, getSnapshot: () => ({ ready: false, error: new Error('[UNSUPPORTED_CAPABILITY] History view scan budget exceeded') }) };
    for (const current of [true, false]) {
      reconcile.mockClear();
      callback(desktopSource, '  view.subscribe(() => {', '\n  });\n  return view;',
        ['isCurrent', 'sessions', 'sessionId', 'view', 'isHistoryViewUnavailable', 'reconcileRemoteMessages'],
        [() => current, new Set(['s']), 's', view, isHistoryViewUnavailable, reconcile]);
      expect(reconcile).toHaveBeenCalledTimes(active && current ? 1 : 0);
      if (active && current) expect(reconcile).toHaveBeenCalledWith('s', { force: true });
    }
  });
  it.each([true, false])('Mobile refills only an active unavailable view (active=%s)', (active) => {
    for (const error of [null, new Error('[CHANNEL_NOT_ALLOWED] Old Host'), new Error('[INTERNAL] transient'), new Error('[UNSUPPORTED_CAPABILITY] History view scan budget exceeded')]) {
      const requestSync = vi.fn();
      callback(mobileSource, '  // Refill the raw mirror through the same coordinator used by initial/recovery reads.\n  useEffect(() => {', '\n  }, [historyView.snapshot.error, historyView.view, requestSync]);',
        ['historyView', 'isHistoryViewUnavailable', 'requestSync'],
        [{ view: { isActive: () => active }, snapshot: { error } }, isHistoryViewUnavailable, requestSync]);
      expect(requestSync).toHaveBeenCalledTimes(active && /UNSUPPORTED_CAPABILITY/.test(String(error)) ? 1 : 0);
      if (active && /UNSUPPORTED_CAPABILITY/.test(String(error))) expect(requestSync).toHaveBeenCalledWith({ reason: 'manual', replaceMessages: true });
    }
  });
});
