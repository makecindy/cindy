/**
 * 伙伴对话皮肤的接线契约。
 *
 * 这三处判定都长在超大组件里(CCAgentSessionView 5k 行 / MessageStream 5.8k 行 /
 * ChatInput 8k 行),在 jsdom 里整棵挂起来既慢又脆。真正要锁死的是**判定条件本身**:
 * 头像与收控件只能对 Bot 会话生效,普通任务的渲染必须一字不改。所以这里锁源码契约,
 * 纯逻辑部分(占位符选词、欢迎语幂等)另有真实单测。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string =>
  readFileSync(resolve(__dirname, '..', '..', '..', relativePath), 'utf8').replace(/\r\n/g, '\n');

const sessionView = read('features/cc-agent/CCAgentSessionView.tsx');
const messageStream = read('components/chat/MessageStream.tsx');
const chatInput = read('components/new-chat/ChatInput.tsx');

describe('Bot 对话的判定条件', () => {
  it('「这是跟伙伴的对话」需要路由身份与 session.source 同时成立', () => {
    // URL 只是导航投影。少了 source 这一半,任何 /bots/... 链接都能把普通任务
    // 伪装成伙伴对话。
    expect(sessionView).toContain(
      "botIdentity && session?.source === 'bot' ? botIdentity : null",
    );
  });

  it('气泡头像只在 Bot 对话下传给消息流', () => {
    expect(sessionView).toContain('assistantAvatar={botAssistantAvatar}');
    expect(sessionView).toContain('botChatIdentity ? (\n        <BotAvatar bot={botChatIdentity}');
  });

  it('输入框的权限 chip 与模型选择器只在 Bot 对话下收起', () => {
    expect(sessionView).toContain('hideRuntimeSelectors={botChatIdentity !== null}');
    expect(sessionView).toContain('botComposerPlaceholderKey(botChatIdentity.name)');
    // 普通任务仍走原来的占位符。
    expect(sessionView).toContain("t('ccAgent.layout.chatPlaceholder')");
  });

  it('伙伴对话换掉任务顶栏,而不是在它旁边再加一个', () => {
    expect(sessionView).toContain('<BotSessionContentHeaderRegistration bot={botChatIdentity} />');
    expect(sessionView).toContain('<SessionContentHeaderRegistration');
  });
});

describe('消息流的头像挂载', () => {
  it('没有头像时原样返回气泡,不多包一层 DOM', () => {
    const helper = messageStream.match(
      /function withAssistantAvatar\([\s\S]*?\n}/,
    )?.[0];
    expect(helper).toBeTruthy();
    expect(helper).toContain('if (!avatar) return bubble;');
  });

  it('只有 assistant 分支挂头像', () => {
    expect(messageStream).toContain('return withAssistantAvatar(\n        assistantAvatar,');
    // 全文只有「定义 + 一处调用」两次出现:user 气泡、工具卡、工作组里的中间
    // 过程文字都不经过它。
    expect(messageStream.match(/withAssistantAvatar\(/g)?.length).toBe(2);
  });
});

describe('输入框收起运行时控件', () => {
  it('权限 chip 直接不渲染,键盘轮切也一并撤掉', () => {
    expect(chatInput).toContain('{hideRuntimeSelectors ? null : (\n                  <PermissionSelector');
    expect(chatInput).toContain('settingsLocked || hideRuntimeSelectors');
  });

  it('模型选择器用 [hidden] 收起,不卸载它的模型记忆', () => {
    expect(chatInput).toContain('hidden={hideRuntimeSelectors}');
  });

  it('默认关闭:任何没传这个 prop 的调用点行为不变', () => {
    expect(chatInput).toContain('hideRuntimeSelectors = false,');
  });
});

/**
 * 批次 ε:成长尾注。判定层(botGrowth.ts)有真实单测,这里只锁**接线**——尾注
 * 是否真的只对伙伴对话生效、是否只挂在收尾正文上。
 */
describe('成长尾注的接线', () => {
  it('只有伙伴对话把 botId 传进消息流,普通任务连判定都不跑', () => {
    expect(sessionView).toContain('botGrowthBotId={botChatIdentity?.id}');
    // 普通任务拿模块级空表,不遍历消息,也不产生新对象引用。
    expect(messageStream).toContain('if (!botGrowthBotId) {');
    expect(messageStream).toContain('return EMPTY_BOT_GROWTH_NOTES;');
    expect(messageStream).toContain('const EMPTY_BOT_GROWTH_NOTES');
  });

  it('尾注挂在 assistant 收尾正文上,判定复用 action bar 那套 turn 口径', () => {
    expect(messageStream).toContain(
      'collectBotGrowthNotes(visibleMessages, turnFinalAssistantClientIds)',
    );
    expect(messageStream).toContain('<BotGrowthNote botId={growthBotId} note={growthNote} />');
  });

  it('两个条件都成立才渲染:是伙伴对话,且这轮真的写了记忆', () => {
    expect(messageStream).toContain('{growthBotId && growthNote ? (');
  });

  it('工作组里的中间过程文字不挂尾注(与头像同一条口径)', () => {
    // MessageItem 有两个调用点,只有对话流那处传 growth 相关 prop。
    expect(messageStream.match(/growthNote=\{/g)?.length).toBe(1);
    expect(messageStream.match(/growthBotId=\{/g)?.length).toBe(1);
  });
});
