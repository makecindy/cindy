import { describe, expect, it } from 'vitest';
import {
  MOBILE_SUPPORTED_DESKTOP_COMMANDS,
  buildLearnCardData,
  buildLearnStartRequest,
  filterMobileDesktopCommands,
  parseMobileDesktopCommand,
} from '@/session/desktopSlashCommands';
import type { MobileSlashCommand } from '@/device-link/mobileMakerTransport';

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

  it('白名单集合当前只含 learn(新增命令需同步实现分流)', () => {
    expect([...MOBILE_SUPPORTED_DESKTOP_COMMANDS]).toEqual(['learn']);
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
