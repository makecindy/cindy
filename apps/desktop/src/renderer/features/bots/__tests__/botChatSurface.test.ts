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
const messageActionBar = read('components/chat/MessageActionBar.tsx');
const chatInput = read('components/new-chat/ChatInput.tsx');
const botSettings = read('features/bots/BotsHomeView.tsx');

describe('Bot 对话的判定条件', () => {
  it('「这是跟伙伴的对话」需要路由身份与 session.source 同时成立', () => {
    // URL 只是导航投影。少了 source 这一半,任何 /bots/... 链接都能把普通任务
    // 伪装成伙伴对话。
    expect(sessionView).toContain("botIdentity && session?.source === 'bot' ? botIdentity : null");
  });

  it('气泡头像只在 Bot 对话下传给消息流', () => {
    expect(sessionView).toContain('assistantAvatar={botAssistantAvatar}');
    expect(sessionView).toContain('<BotAvatar bot={botChatIdentity} size="sm" />');
  });

  it('伙伴对话换占位符并启用轻量输入框', () => {
    expect(sessionView).toContain('botComposerPlaceholderKey(botChatIdentity.name)');
    expect(sessionView).toContain('hideRuntimeControls={Boolean(botChatIdentity)}');
    // 普通任务仍走原来的占位符。
    expect(sessionView).toContain("t('ccAgent.layout.chatPlaceholder')");
  });

  it('伙伴对话换掉任务顶栏,而不是在它旁边再加一个', () => {
    expect(sessionView).toContain(
      '<BotSessionContentHeaderRegistration bot={botChatIdentity} sessionId={sessionId} />',
    );
    expect(sessionView).toContain('<SessionContentHeaderRegistration');
  });
});

describe('消息流的头像挂载', () => {
  it('没有头像时原样返回气泡,不多包一层 DOM', () => {
    const helper = messageStream.match(/function withAssistantAvatar\([\s\S]*?\n}/)?.[0];
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

describe('伙伴输入框只保留对话动作', () => {
  it('权限 chip 与模型选择器共用同一隐藏门', () => {
    expect(chatInput.match(/!hideRuntimeControls \? \(/g)?.length).toBe(2);
    expect(chatInput).toContain('<PermissionSelector');
    expect(chatInput).toContain('<ModelSelector');
  });

  it('隐藏控件时也禁用权限快捷键', () => {
    expect(chatInput).toContain('settingsLocked || hideRuntimeControls');
  });

  it('伙伴不渲染任务目录、费用或压缩状态行', () => {
    expect(sessionView).toContain('{!botChatIdentity ? (');
    expect(sessionView).toContain('<TodaySpendChip');
    expect(sessionView).toContain('<ContextCapacityRing');
  });
});

describe('伙伴设置收口为基本资料与高级文件入口', () => {
  it('不再挂载旧成长列表或全局能力目录', () => {
    expect(botSettings).not.toContain('import { BotCapabilitySettings }');
    expect(botSettings).not.toContain('<BotCapabilitySettings');
    expect(botSettings).not.toContain('<BotGrowthLists');
    expect(botSettings).toContain('<BotBasicProfileFields');
    expect(botSettings).toContain("t('bots.homeFolder.title')");
  });
});

describe('伙伴消息流收起内部工作过程', () => {
  it('只对伙伴过滤工作卡，正文流式出现后让单一思考状态退场', () => {
    expect(sessionView).toContain('simplifiedBotConversation={Boolean(botChatIdentity)}');
    expect(messageStream).toContain('simplifyBotRenderItems(grouped, isSessionStreaming)');
    expect(messageStream).toContain("item.message.role === 'assistant'");
    expect(messageStream).toContain('item.message.content.trim().length > 0');
    expect(messageStream).not.toContain('data-testid="bot-thinking-indicator"');
    expect(sessionView).toContain('data-testid="bot-thinking-indicator"');
    expect(sessionView).toContain("t('ccAgent.agentStatus.thinking')");
    expect(sessionView).toContain('botChatIdentity ? (');
    expect(sessionView).toContain(
      'Boolean(botChatIdentity) && hasBotAssistantOutputInCurrentTurn(messages)',
    );
    expect(sessionView).toContain('composerRuntimeVisible && !botAssistantOutputStarted');
    expect(sessionView).toContain('botThinkingVisible ? (');
  });

  it('时间戳只挂在伙伴消息分组上', () => {
    expect(messageStream).toContain('collectBotMessageTimeGroups(');
    expect(messageStream).toContain('botMessageTimeGroups.get(msg.clientId)');
  });

  it('未读起点只挂在伙伴消息流，不会创建分支', () => {
    expect(sessionView).toContain(
      'botUnreadBoundaryAt={botChatIdentity ? botUnreadBoundaryAt : null}',
    );
    expect(messageStream).toContain("t('bots.chat.newMessagesBoundary')");
    expect(messageStream).toContain('botUnreadBoundaryClientId === msg.clientId');
  });

  it('伙伴消息操作栏常显，外显回复，并隐藏费用与 Fork', () => {
    expect(messageStream).toContain('simplifiedBotConversation={simplifiedBotConversation}');
    expect(messageActionBar).toContain('const replyBtn = simplifiedBotConversation');
    expect(messageActionBar).toContain('const forkBtn = !simplifiedBotConversation');
    expect(messageActionBar).toContain('simplifiedBotConversation ? null : costText || tokensText');
    expect(messageActionBar).toContain('simplifiedBotConversation || visible || menuOpen');
  });
});

/**
 * 恢复选择器带来的**必须**配套:伙伴主任务会在 Renew 时按 Profile 的
 * capabilities 重建,输入框只写会话行的话,用户选的模型会在 Renew 后回跳。
 */
describe('伙伴对话的运行时选择回写 Profile', () => {
  it('模型 / effort / 权限 / 供应商 / fast 五个入口都接上了回写', () => {
    expect(sessionView).toContain('mirrorBotComposerRuntime({ model: newModelId })');
    expect(sessionView).toContain('mirrorBotComposerRuntime({ effort: newEffort })');
    expect(sessionView).toContain('mirrorBotComposerRuntime({ permissionMode: newMode })');
    expect(sessionView).toContain('mirrorBotComposerRuntime({ providerId: newProviderId })');
    expect(sessionView).toContain('mirrorBotComposerRuntime({ fastMode: next })');
    expect(sessionView).toContain('onProviderDidChange={handleProviderDidChange}');
    expect(sessionView).toContain('onFastModeChange={handleFastModeChange}');
  });

  it('普通任务一行都不写:没有伙伴身份就直接返回', () => {
    expect(sessionView).toContain(
      'const botId = botChatIdentityRef.current?.id;\n      if (!botId) return;',
    );
  });
});
