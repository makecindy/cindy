import { describe, expect, it } from 'vitest';

import {
  requireCodexQueuedAppshots,
  validateAndStripAppshotMetadata,
} from '../appshotBoundary';

const metadata = {
  schemaVersion: 1,
  captureId: 'capture-1',
  capturedAt: '2026-08-06T01:02:03.000Z',
  applicationName: 'Cindy',
  bundleIdentifier: 'com.xd.cindy',
  windowTitle: 'Draft',
  accessibilityText: null,
  accessibilityTruncated: false,
};

describe('Appshot send boundary', () => {
  it('keeps a valid Appshot on Codex messages and strips malformed metadata', () => {
    const message = {
      type: 'user' as const,
      content: [
        { type: 'image', path: '/tmp/capture.png', mimeType: 'image/png', appshot: metadata },
        { type: 'image', path: '/tmp/ordinary.png', mimeType: 'image/png', appshot: { bad: true } },
      ],
    };

    const result = validateAndStripAppshotMetadata(message, 'codex');

    expect(result.hasAppshot).toBe(true);
    expect((result.message as { type: 'user'; content: unknown[] }).content).toEqual([
      expect.objectContaining({ appshot: metadata }),
      { type: 'image', path: '/tmp/ordinary.png', mimeType: 'image/png' },
    ]);
  });

  it('rejects Appshots for Claude Code and Pi while leaving ordinary images valid', () => {
    const ordinary = { type: 'user' as const, content: [{ type: 'image', path: '/tmp/image.png' }] };
    expect(validateAndStripAppshotMetadata(ordinary, 'claude-code').hasAppshot).toBe(false);
    expect(validateAndStripAppshotMetadata(ordinary, 'pi').hasAppshot).toBe(false);

    const appshot = {
      ...ordinary,
      content: [{ ...ordinary.content[0], appshot: metadata }],
    };
    expect(() => validateAndStripAppshotMetadata(appshot, 'claude-code')).toThrow(
      'Appshots are only supported in Codex sessions',
    );
    expect(() => validateAndStripAppshotMetadata(appshot, 'claude-code')).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(() => validateAndStripAppshotMetadata(appshot, 'pi')).toThrow(
      'Appshots are only supported in Codex sessions',
    );
  });

  it('rejects queued Appshots before they enter the coordinator', () => {
    const queued = {
      clientId: 'client-1',
      text: '',
      persistedContent: '{}',
      createOpts: { agentKind: 'claude-code' },
      files: [{ appshot: metadata }],
    };
    expect(() => requireCodexQueuedAppshots(queued)).toThrow(
      'Appshots are only supported in Codex sessions',
    );
    expect(() => requireCodexQueuedAppshots({ ...queued, createOpts: { agentKind: 'codex' } })).not.toThrow();
  });
});
