import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('session focus retry wiring', () => {
  const mainSource = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const gatewaySource = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/subscriptionGateway.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('forwards same-id IPC focus reports to the primary tracker for retries', () => {
    const start = mainSource.indexOf('function noteGhostWindowSessionFocused(');
    const end = mainSource.indexOf('\n}\n\nfunction mainShellWindows', start);
    const body = mainSource.slice(start, end);

    expect(body).toContain('if (previous !== sessionId)');
    expect(body).toContain('syncIOSSimulatorRendererAccessForSessionChange(sender, sessionId);');
    expect(body).toContain('noteGhostSessionFocused(sessionId);');
    expect(body).not.toContain('if (previous === sessionId) return;');
  });

  it('releases raw focus after a failed publication recheck', () => {
    const start = gatewaySource.indexOf('export function createGhostPrimarySessionFocusTracker(');
    const end = gatewaySource.indexOf('\n}\n\n/* ──', start);
    const body = gatewaySource.slice(start, end);

    expect(body).toContain('recheckedPrimarySessionId = await resolve(sessionId);');
    expect(body).toContain('lastRawSessionId = null;');
    expect(body).toContain('primarySessionId === lastPrimarySessionId');
  });

  it('releases raw focus when session-switch eligibility is temporarily unavailable', () => {
    const start = mainSource.indexOf('export function notifyGhostSessionEvent(');
    const end = mainSource.indexOf('\n}\n\n/**\n * 会话切换上报入口', start);
    const body = mainSource.slice(start, end);

    expect(body).toContain('onRetry: () => void = () => {}');
    expect(body).toContain("if (info.outcome === 'retry') onRetry();");
    expect(mainSource).toContain(
      "notifyGhostSessionEvent('switched', { sessionId }, claim, releaseRaw)",
    );
  });
});
