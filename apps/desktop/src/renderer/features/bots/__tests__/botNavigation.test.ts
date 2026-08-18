import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { shouldDeferCanonicalBotSessionNavigation } from '../botNavigation';

describe('shouldDeferCanonicalBotSessionNavigation', () => {
  it.each([
    ['Bot settings are open', { settingsOpen: true, addOpen: false, addRequested: false }],
    ['the add dialog is open', { settingsOpen: false, addOpen: true, addRequested: false }],
    [
      'the add route was requested before dialog state catches up',
      { settingsOpen: false, addOpen: false, addRequested: true },
    ],
  ])('defers navigation while %s', (_label, input) => {
    expect(shouldDeferCanonicalBotSessionNavigation(input)).toBe(true);
  });

  it('allows canonical Session navigation after overlays close', () => {
    expect(
      shouldDeferCanonicalBotSessionNavigation({
        settingsOpen: false,
        addOpen: false,
        addRequested: false,
      }),
    ).toBe(false);
  });
});

describe('Bot task route recovery', () => {
  const source = readFileSync(resolve(__dirname, '..', 'BotSessionView.tsx'), 'utf8');

  it('keeps load failures visible and retryable instead of silently redirecting', () => {
    expect(source).not.toContain('<Navigate');
    expect(source).toContain("kind: 'error'");
    expect(source).toContain('setReloadVersion');
    expect(source).toContain('bots.sessionLoadFailedTitle');
  });

  it('passes the live Bot roster and the teammate identity into the shared task composer', () => {
    expect(source).toContain('window.electronAPI.localDb.bots.list()');
    expect(source).toContain(
      '<CCAgentSessionView botMentions={gate.mentions} botIdentity={gate.identity} />',
    );
  });

  it('delivers the parked greeting only once the durable Bot link has been verified', () => {
    // 交付点必须在 gate 通过之后:URL 不是身份,先落一条消息再校验就等于让
    // 任意 /bots/:id/session/:id 链接往别人的任务里写话。
    expect(source).toContain('deliverPendingBotWelcome');
    expect(source).toContain("if (gate.kind !== 'ready'");
  });
});
