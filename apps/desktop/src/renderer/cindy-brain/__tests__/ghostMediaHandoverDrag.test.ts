/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

import { GHOST_MEDIA_HANDOVER_MIME } from '../../../shared/ghost';
import { GhostMediaHandoverTargetTracker, ghostMediaHandoverDragScript } from '../../../main/cindy-brain/ghostMediaHandoverTargetTracker';
import { getGhostMediaHandoverFromDataTransfer } from '../ghostMediaHandover';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/composerDraftStore', () => ({ getDraft: vi.fn(), saveDraft: vi.fn() }));

describe.each(['helper', '_ns__acme__helper'])('Main-injected Ghost drag source %s', (instanceId) => {
  it.each([
    ['a', 'href', 'preview', '.png'],
    ['img', 'src', 'media', '.png'],
    ['video', 'src', 'media', '.mp4'],
    ['div', 'data-uri', 'media', '.png'],
  ])('carries the registered source for a default %s drag without an author API', (tag, attribute, shape, ext) => {
    const tracker = new GhostMediaHandoverTargetTracker();
    const token = tracker.register({ ghostId: 'helper', instanceId, isCurrent: () => true });
    const addEventListener = vi.fn();
    new Function('window', ghostMediaHandoverDragScript(token))({ addEventListener });
    expect(addEventListener).toHaveBeenCalledWith('dragstart', expect.any(Function), true);
    const listener = addEventListener.mock.calls[0][1] as (event: unknown) => void;
    const uri = 'cindy-ghost://helper/' + shape + '/' + 'a'.repeat(64) + ext;
    const target = document.createElement(tag);
    target.setAttribute(attribute, uri);
    const values: Record<string, string> = tag === 'div' ? { 'text/uri-list': uri } : {};
    const dataTransfer = {
      get types() { return Object.keys(values); },
      getData: (type: string) => values[type] ?? '',
      setData: (type: string, value: string) => { values[type] = value; },
    };
    listener({ isTrusted: false, target, dataTransfer });
    expect(values[GHOST_MEDIA_HANDOVER_MIME]).toBeUndefined();
    listener({ isTrusted: true, target, dataTransfer });
    const source = getGhostMediaHandoverFromDataTransfer(dataTransfer as unknown as DataTransfer);
    expect(source).toEqual({ uri, sourceToken: token });
    expect(tracker.resolve(source?.sourceToken, source?.uri)).toEqual({ ghostId: 'helper', instanceId });
    tracker.revoke(token);
    expect(tracker.resolve(source?.sourceToken, source?.uri)).toBeNull();
  });
});
