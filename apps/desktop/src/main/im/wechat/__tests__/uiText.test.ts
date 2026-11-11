import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setMainLocale } from '../../../i18n.desktop';
import { ui } from '../uiText';
import { localizedReplyWords } from '../../shared/replyWords';
import { __testing } from '../WechatIM';

describe('WeChat UI text', () => {
  beforeEach(() => setMainLocale('zh-CN'));
  afterEach(() => setMainLocale('en'));

  it('uses WeChat-specific copy for channel-sensitive replies', () => {
    const channelCopy = [
      ui.slash.help,
      ui.slash.detachedBySlash,
      ui.slash.detachedByRevoke,
      ui.agent.authMissing?.({
        agentKind: 'codex',
        model: 'gpt',
        providerId: 'openai',
        providerLabel: 'OpenAI',
        missing: 'provider-key',
      }),
      ...ui.cards.control.takeoverLoadingPrompts.map((prompt) => prompt('会话')),
      ...ui.cards.control.sessionAttachedOneshotPrompts,
    ].join('\n');

    expect(channelCopy).toContain('微信');
    expect(channelCopy).not.toMatch(/Discord|飞书/);
  });

  it('keeps the Chinese copy and interpolates variables in zh-CN', () => {
    expect(ui.agent.queuedNotice(3)).toBe(
      '⏳ 上一轮还在跑，这条排在第 3 位——会按顺序发给 Agent。想直接叫停就发 `!stop`',
    );
    expect(ui.agent.stopDone(2)).toContain('排队中的 2 条消息');
    expect(ui.slash.unknownCommand('/foo')).toContain('`/foo`');
  });

  it('follows the interface language at send time', () => {
    const zh = ui.slash.new;
    setMainLocale('en');
    expect(ui.slash.new).not.toBe(zh);
    expect(ui.slash.new).toMatch(/^🌱 Fresh start/);
    expect(ui.cards.permission.btnDeny).toBe('❌ Deny');
    expect(ui.cards.control.sessionBusyPrompts[0]('Build')).toContain('**Build**');
  });

  it('renders English control copy with interpolated variables and plurals', () => {
    setMainLocale('en');
    expect(ui.agent.queuedNotice(4)).toContain('#4 in the queue');
    expect(ui.agent.stopDone(1)).toContain('dropped 1 queued message.');
    expect(ui.agent.stopDone(3)).toContain('dropped 3 queued messages.');
    expect(ui.cards.model.resolved('GPT-5', 'high')).toBe('✅ Switched to GPT-5 (reasoning effort: high)');
    expect(
      ui.agent.authMissing?.({
        agentKind: 'codex',
        model: 'gpt',
        providerId: 'openai',
        providerLabel: null,
        missing: 'provider-disconnected',
        attached: true,
      }),
    ).toBe(
      '⚠️ This WeChat conversation uses the provider “openai” (gpt), which is not connected or whose connection has expired.\n'
      + 'Fix the authentication in the desktop app under Settings → Providers, then just keep sending messages.',
    );
    expect(__testing.wechatPreDispatchFailureText('missing_auth')).toBe(
      "The current Agent isn't authorized yet. Connect a model service in Cindy first.",
    );
    const prompt = __testing.formatWechatInteractionPrompt({
      kind: 'permission',
      requestId: 'r-en',
      toolName: 'Bash',
      input: {},
    });
    expect(prompt).toContain('The tool “Bash” needs your confirmation.');
    expect(prompt).toContain('Reply “allow” to run it once');
    // The English reply token the prompt advertises is accepted by the parser.
    expect(
      __testing.parseWechatInteractionReply(
        { kind: 'permission', requestId: 'r-en', toolName: 'Bash', input: {} },
        'allow',
      ),
    ).toEqual({ kind: 'permission', behavior: 'allow' });
  });
});

it.each([
  ['permission', 'erlauben', 'allow'], ['permission', 'ablehnen', 'deny'],
  ['plan_review', 'genehmigen', 'allow'], ['plan_review', 'ablehnen', 'deny'],
] as const)('uses the prompt snapshot for WeChat %s reply %s', (kind, reply, behavior) => {
  setMainLocale('de');
  const request = kind === 'permission'
    ? { kind, requestId: 'switch', toolName: 'Bash', input: {} }
    : { kind, requestId: 'switch', plan: 'Plan' };
  const words = localizedReplyWords();
  expect(__testing.formatWechatInteractionPrompt(request, words)).toContain(reply);
  setMainLocale('en');
  expect(__testing.parseWechatInteractionReply(request, reply, words)).toMatchObject({ kind, behavior });
  expect(__testing.parseWechatInteractionReply(request, 'unrelated', words)).toBeNull();
});
