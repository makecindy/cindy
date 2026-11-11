import { describe, expect, it, vi } from 'vitest';
import {
  buildLearnCardData,
  buildLearnStartRequest,
  buildMobileSideChatDraft,
  executeMobileGoalCommand,
  mergeMobileGoalCommand,
  mergeMobileSideChatCommand,
  filterMobileDesktopCommands,
  parseMobileDesktopCommand,
} from '@/session/desktopSlashCommands';
import type { MobileSlashCommand } from '@/device-link/mobileMakerTransport';
import { composerDocumentProjectedText, serializeComposerDocument, sessionLinkComposerNode, type ComposerDocument } from '@/session/composerDocument';

// Unit regression: /side previously flattened a message chip to a URL and lost
// its body. Command parsing tests only covered strings, not transferred drafts.
describe('side chat draft transfer', () => {
  it('preserves message bodies, project references and interleaved quotes for the child send', () => {
    const reference = sessionLinkComposerNode({
      href: 'cindy://session/other-task?message=message-1',
      label: 'Referenced message', agentText: 'The original message body',
    });
    const document: ComposerDocument = { version: 1, nodes: [
      { type: 'text', text: '  /side', slashCommand: '/side' },
      { type: 'quote', quote: { text: 'quoted answer' } },
      { type: 'text', text: ' explain ' },
      reference,
      { type: 'text', text: ' using ' },
      { type: 'mention', kind: 'project', label: 'Project', raw: 'cindy://project/%2Fwork',
        href: 'cindy://project/%2Fwork', workingDir: '/work' },
    ] };
    expect(parseMobileDesktopCommand(composerDocumentProjectedText(document))?.name).toBe('side');
    const draft = buildMobileSideChatDraft(document);
    expect(draft.nodes[0]).toEqual(document.nodes[1]);
    const sent = serializeComposerDocument(draft);
    expect(sent.agentReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message', messageClientId: 'message-1', text: 'The original message body' }),
      expect.objectContaining({ kind: 'project', workingDir: '/work' }),
    ]));
    expect(sent.text).not.toContain('/side');
    expect(document.nodes[0]).toMatchObject({ text: '  /side' });
  });

  it('keeps a quote-only draft when the command has no visible arguments', () => {
    const document: ComposerDocument = { version: 1, nodes: [
      { type: 'text', text: '/side' }, { type: 'quote', quote: { text: 'keep' } }, { type: 'text', text: '  ' },
    ] };
    expect(buildMobileSideChatDraft(document).nodes).toEqual([document.nodes[1]]);
  });
});

describe('filterMobileDesktopCommands', () => {
  it('只保留 desktop kind 且在移动端白名单内的命令', () => {
    const commands: MobileSlashCommand[] = [
      { kind: 'desktop', name: 'learn', description: 'distill' },
      { kind: 'desktop', name: 'jump-session', description: 'ui only' },
      { kind: 'agent-builtin', name: 'learn', description: 'not desktop' },
    ];
    expect(filterMobileDesktopCommands(commands)).toEqual([
      { kind: 'desktop', name: 'learn', description: 'distill' },
    ]);
  });
});

describe('parseMobileDesktopCommand', () => {
  it('命中白名单命令并抽出参数', () => {
    expect(parseMobileDesktopCommand('/learn 总结这个任务的调试技巧')).toEqual({
      name: 'learn',
      args: '总结这个任务的调试技巧',
    });
  });

  it('裸命令参数为空串', () => {
    expect(parseMobileDesktopCommand('  /learn  ')).toEqual({ name: 'learn', args: '' });
  });

  it('已加载清单里有同名 agent-skill 时让行(对齐桌面 dispatch:skill 优先)', () => {
    const loaded: MobileSlashCommand[] = [
      { kind: 'agent-skill', name: 'learn', source: 'user', description: 'user skill' },
    ];
    expect(parseMobileDesktopCommand('/learn xxx', loaded)).toBeNull();
    // 同名 desktop / builtin 不构成让行;清单为空(未加载/失败)时白名单兜底拦截。
    expect(parseMobileDesktopCommand('/learn xxx', [
      { kind: 'desktop', name: 'learn', description: 'desktop' },
      { kind: 'agent-builtin', name: 'learn', description: 'builtin' },
    ])).toEqual({ name: 'learn', args: 'xxx' });
    expect(parseMobileDesktopCommand('/learn xxx', [])).toEqual({ name: 'learn', args: 'xxx' });
  });

  it('白名单外的 desktop 命令与普通文本都不拦截', () => {
    expect(parseMobileDesktopCommand('/jump-session xxx')).toBeNull();
    expect(parseMobileDesktopCommand('/help')).toBeNull(); // mobile-local 卡片命令另有分流
    expect(parseMobileDesktopCommand('learn something')).toBeNull();
    expect(parseMobileDesktopCommand('文本里提到 /learn 不算')).toBeNull();
  });

  // Unit: the new mobile /side entry must open locally rather than reach the
  // main agent. Existing /learn coverage did not cover bare/prefilled side chats
  // or a same-name skill in the locally seeded palette.
  it('opens empty or prefilled side chats without intercepting other text', () => {
    expect(parseMobileDesktopCommand('/side')).toEqual({ name: 'side', args: '' });
    expect(parseMobileDesktopCommand('/side 为什么要限制并发？')).toEqual({ name: 'side', args: '为什么要限制并发？' });
    expect(parseMobileDesktopCommand('/sidebar')).toBeNull();
    expect(parseMobileDesktopCommand('解释一下 /side')).toBeNull();
  });

  it('seeds the side entry before catalogue loading and preserves a same-name skill', () => {
    const seeded = mergeMobileSideChatCommand([], 'Open a side chat');
    expect(filterMobileDesktopCommands(seeded)).toEqual([{ name: 'side', kind: 'desktop', description: 'Open a side chat' }]);
    const skill: MobileSlashCommand = { name: 'side', kind: 'agent-skill', source: 'user', description: 'My skill' };
    const commands = mergeMobileSideChatCommand([skill], 'Open a side chat');
    expect(commands.find(command => command.name === 'side')).toEqual(skill);
    expect(parseMobileDesktopCommand('/side inspect', commands)).toBeNull();
  });
});

describe('buildLearnStartRequest(语义对齐桌面 builtins.ts 的 /learn)', () => {
  it('有参数 → freetext,并挂 originSessionId', () => {
    expect(buildLearnStartRequest('学会这个流程', 's-1')).toEqual({
      input: '学会这个流程',
      sourceKind: 'freetext',
      originSessionId: 's-1',
    });
  });

  it('无参数 → 蒸馏当前会话(session)', () => {
    expect(buildLearnStartRequest('', 's-1')).toEqual({
      input: '',
      sourceKind: 'session',
      originSessionId: 's-1',
    });
  });

  it('hub:<slug> 前缀 → hub 蒸馏,剩余文本作补充要求', () => {
    expect(buildLearnStartRequest('hub:deploy-checklist 按我们团队习惯改', 's-1')).toEqual({
      input: '按我们团队习惯改',
      sourceKind: 'hub',
      hubSlug: 'deploy-checklist',
      hubCatalogScope: 'market',
      originSessionId: 's-1',
    });
  });

  it('hub:<scope>:<slug> 保留目录作用域', () => {
    expect(buildLearnStartRequest('hub:team:deploy-checklist 精简', 's-1')).toEqual({
      input: '精简',
      sourceKind: 'hub',
      hubSlug: 'deploy-checklist',
      hubCatalogScope: 'team',
      originSessionId: 's-1',
    });
  });

  it('非法 hub slug 不按 hub 解析(与桌面正则一致,落 freetext 由被控端再校验)', () => {
    expect(buildLearnStartRequest('hub:Bad_Slug xx', 's-1').sourceKind).toBe('freetext');
  });
});

describe('buildLearnCardData', () => {
  it('成功 → runId 卡数据', () => {
    expect(buildLearnCardData({ runId: 'r-123' })).toEqual({ runId: 'r-123' });
  });

  it('LEARN_BUSY 隧道编码 → learn-busy', () => {
    expect(buildLearnCardData({ errorMessage: '[LEARN_BUSY] learn run r-1 is already in progress' }))
      .toEqual({ error: 'learn-busy', detail: '[LEARN_BUSY] learn run r-1 is already in progress' });
  });

  it('其它错误 → learn-failed 并保留原文', () => {
    expect(buildLearnCardData({ errorMessage: '[NOT_CONNECTED] not online' }))
      .toEqual({ error: 'learn-failed', detail: '[NOT_CONNECTED] not online' });
  });
});


describe('mobile /goal business routing', () => {
  const goalApi = () => ({ set: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ objective: '目标', status: 'active' }),
    pause: vi.fn(), resume: vi.fn(), update: vi.fn() });

  it('shows Goal without loading the roster, and preserves a same-name Skill', () => {
    expect(mergeMobileGoalCommand([], 'Goal Mode')).toEqual([{ kind: 'desktop', name: 'goal', description: 'Goal Mode' }]);
    const skill = { kind: 'agent-skill', name: 'goal', description: 'skill' } as MobileSlashCommand;
    expect(mergeMobileGoalCommand([skill], 'Goal Mode')).toEqual([skill]);
    expect(parseMobileDesktopCommand('/goal target', [skill])).toBeNull();
    expect(parseMobileDesktopCommand('/goal target')).toEqual({ name: 'goal', args: 'target' });
    expect(filterMobileDesktopCommands([{ kind: 'desktop', name: 'goal', description: 'Goal Mode' }])).toHaveLength(1);
  });

  it('bare /goal opens the existing panel without setting a goal', async () => {
    const api = goalApi();
    expect(await executeMobileGoalCommand('', 's1', api)).toMatchObject({ command: { action: 'open-dialog' } });
    expect(api.getStatus).toHaveBeenCalledExactlyOnceWith('s1');
    expect(api.set).not.toHaveBeenCalled();
    expect(api.clear).not.toHaveBeenCalled();
  });

  it('sets the actual task goal once and reads authoritative status', async () => {
    const api = goalApi();
    const result = await executeMobileGoalCommand('  目标  ', 'existing-task', api);
    expect(api.set).toHaveBeenCalledExactlyOnceWith({ sessionId: 'existing-task', objective: '目标' });
    expect(api.getStatus).toHaveBeenCalledWith('existing-task');
    expect(result.status).toMatchObject({ objective: '目标', status: 'active' });
  });

  it.each(['clear', 'STOP', 'off', 'cancel', 'reset', 'none'])('clears for desktop alias %s', async args => {
    const api = goalApi();
    await executeMobileGoalCommand(args, 's1', api);
    expect(api.clear).toHaveBeenCalledExactlyOnceWith('s1');
    expect(api.set).not.toHaveBeenCalled();
  });

  it('propagates unsupported/connection errors, never falls through to a message', async () => {
    const api = goalApi();
    api.set.mockRejectedValue(new Error('[CHANNEL_NOT_ALLOWED] old host'));
    await expect(executeMobileGoalCommand('目标', 's1', api)).rejects.toThrow('CHANNEL_NOT_ALLOWED');
    expect(api.set).toHaveBeenCalledOnce();
    expect(api.getStatus).not.toHaveBeenCalled();
  });

  it('does not replay goal.set when only status refresh fails', async () => {
    const api = goalApi();
    api.getStatus.mockRejectedValue(new Error('offline'));
    expect((await executeMobileGoalCommand('目标', 's1', api)).status).toBeUndefined();
    expect(api.set).toHaveBeenCalledOnce();
  });
});
