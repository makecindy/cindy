// Native helper contract tier: Swift cannot be imported by the JS host tests.
// Preserve cross-runtime display/protocol, focus ownership and wake-refresh
// contracts here; process recovery remains in MacAgentIslandNativeHost.test.ts.
// Minimal failures are missing native protocol fields, activation or stale metrics.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Agent Island native contracts', () => {
  it('renders the idle brand from main-provided display strings', () => {
    const sourceUrl = new URL(
      '../../../../native/agent-island/macos-agent-island-helper.swift',
      import.meta.url,
    );
    if (!fs.existsSync(sourceUrl)) {
      throw new Error(`macos-agent-island-helper.swift 未找到: ${sourceUrl.pathname}`);
    }
    const source = fs.readFileSync(sourceUrl, 'utf8');

    expect(source).toContain('Text(strings.displayAppName)');
    expect(source).not.toContain('Text("XD Maker")');
  });

  it('keeps the native panel nonactivating during pointer interaction', () => {
    const sourceUrl = new URL(
      '../../../../native/agent-island/macos-agent-island-helper.swift',
      import.meta.url,
    );
    const source = fs.readFileSync(sourceUrl, 'utf8');

    expect(source).toContain('styleMask: [.borderless, .nonactivatingPanel]');
    expect(source).toContain('override var canBecomeKey: Bool { false }');
    expect(source).toContain('override var canBecomeMain: Bool { false }');
    expect(source).not.toContain('makeKey()');
  });

  it('refreshes native display metrics after macOS wakes from sleep', () => {
    const source = fs.readFileSync(
      new URL('../../../../native/agent-island/macos-agent-island-helper.swift', import.meta.url),
      'utf8',
    );

    const wakeObserver = source.match(
      /workspaceWakeObserver\s*=\s*NSWorkspace\.shared\.notificationCenter\.addObserver\(\s*forName:\s*NSWorkspace\.didWakeNotification,[\s\S]*?self\?\.scheduleScreenMetricsPublish\(forceRefresh:\s*true\)\s*\n\s*}/,
    )?.[0];

    expect(wakeObserver).toBeTruthy();
    expect(wakeObserver).toContain('NSWorkspace.didWakeNotification');
    expect(wakeObserver).toContain('scheduleScreenMetricsPublish(forceRefresh: true)');
    expect(source).toContain('payload["forceRefresh"] = true');
  });

});
