import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isHostManagedSession } from '@/session/hostManagedSession';

describe('host-managed Session presentation', () => {
  it('trusts the authoritative Session source instead of route metadata', () => {
    expect(isHostManagedSession({ source: 'bot' })).toBe(true);
    expect(isHostManagedSession({ source: 'desktop' })).toBe(false);
    expect(isHostManagedSession(null)).toBe(false);
  });

  it('removes Session-container and runtime controls while preserving the composer', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    expect(source).toContain('const sessionManagedByHost = isHostManagedSession(currentSession);');
    expect(source).toContain('messageOnly={sessionManagedByHost}');
    expect(source).toContain('currentSession && !sessionManagedByHost ? (');
    expect(source).toContain('!sessionManagedByHost ? renderSessionPermissionButton() : null');
    expect(source).toContain('!sessionManagedByHost && composerRuntimeSummary ? (');
    expect(source).toContain('{renderComposerAttachmentButton()}');
    expect(source).toContain('{renderComposerInlineStop()}');
  });
});
