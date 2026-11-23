/**
 * 测试价值
 * - 生产入口与可观察结果：`@/device-link/desktopEntryModel` 的公开函数。用户可见结果是桌面上
 *   那枚组件卡片的标题 / 头像，以及点开后落到哪个页面；被篡改的深链不能把用户带到别处。
 * - Bug／规则依据：组件把深链和图标一次性写进系统那份快照，组件自己不联网，所以标题必须在写入
 *   前就压成一行、链接必须能独立校验。白名单来自 docs/dev-rules/mobile-development.md
 *   「安卓桌面不做固定快捷方式」与「Android 桌面入口组件」。
 * - 现有覆盖缺口：原生与组件渲染跑不到这些分支（Kotlin / RemoteViews 没有 JS 单测宿主），
 *   写入快照前的纯函数是唯一能在 CI 里锁住它们的接缝。
 * - 最小失败输入：同一位伙伴在两台电脑上、被篡改的 URL 带 `desktopEntry=1`、超长中文名、
 *   会拆开的 ZWJ emoji。
 * - tier：unit（纯函数，无 native / React / 网络）。
 */
import { describe, expect, it } from 'vitest';

import {
  companionDesktopEntryUrl,
  desktopEntryAvatarSignature,
  desktopEntryGlyph,
  desktopEntryId,
  desktopEntryTitle,
  DESKTOP_ENTRY_TITLE_MAX,
  NEW_TASK_DESKTOP_ENTRY_ID,
  newTaskDesktopEntryUrl,
  parseDesktopEntryLink,
} from '@/device-link/desktopEntryModel';

const companion = { kind: 'companion' as const, deviceId: 'device-1', collectionId: 'teammates', companionId: 'bot-1' };
const link = { ...companion, sessionId: 'session-1' };

describe('桌面入口 ID', () => {
  it.each([
    ['新任务', { kind: 'new-task' as const }],
    ['普通伙伴', companion],
    ['含斜杠与空格的电脑 / 集合 / 伙伴 ID', { ...companion, deviceId: 'pc/1', collectionId: 'team mates', companionId: '伙伴 #1' }],
    ['含百分号与问号的 ID', { ...companion, deviceId: 'pc%2F1', collectionId: 'c?d', companionId: 'e#f' }],
  ])('%s：ID 只含 ASCII', (_label, target) => {
    expect(desktopEntryId(target)).toMatch(/^[\x21-\x7e]+$/);
  });

  it('同一伙伴两端电脑上是两个目标，同一身份始终得到同一个 ID', () => {
    const other = { ...companion, deviceId: 'device-2' };
    expect(desktopEntryId(companion)).not.toBe(desktopEntryId(other));
    expect(desktopEntryId({ ...companion })).toBe(desktopEntryId(companion));
  });

  it('新任务使用固定 ID，不随语言或账号变化', () => {
    expect(desktopEntryId({ kind: 'new-task' })).toBe(NEW_TASK_DESKTOP_ENTRY_ID);
    expect(desktopEntryId({ kind: 'new-task' })).toBe('cindy.desktop-entry.new-task');
  });
});

describe('深链 URL 与白名单', () => {
  it('伙伴链接带电脑、伙伴集合、伙伴 ID 与来自桌面的标记', () => {
    const url = companionDesktopEntryUrl({ ...link, deviceId: '电脑 A', collectionId: 'team/mates' }, 'cindycn');
    expect(url).toBe(
      'cindycn://sessions/session-1?desktopEntry=1'
      + `&deviceId=${encodeURIComponent('电脑 A')}`
      + `&resourceCollectionId=${encodeURIComponent('team/mates')}`
      + '&resourceId=bot-1&resourceKind=bot',
    );
    expect(parseDesktopEntryLink(url)).toEqual({
      ...link,
      deviceId: '电脑 A',
      collectionId: 'team/mates',
    });
  });

  it('新任务链接固定指向空白新任务页', () => {
    const url = newTaskDesktopEntryUrl('cindy');
    expect(url).toBe('cindy://sessions/new?desktopEntry=1');
    expect(parseDesktopEntryLink(url)).toEqual({ kind: 'new-task' });
  });

  it.each([
    ['只有页面路径、没有 scheme', '/sessions/session-1?desktopEntry=1&deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot', link],
    ['带 fragment', 'cindy://sessions/session-1?desktopEntry=1&deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot#top', link],
  ])('%s 仍能解析', (_label, url, expected) => {
    expect(parseDesktopEntryLink(url)).toEqual(expected);
  });

  it.each([
    ['没有标记', 'cindy://sessions/session-1?deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot'],
    ['标记被改成 0', 'cindy://sessions/session-1?desktopEntry=0&deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot'],
    ['重复参数用后面的值覆盖', 'cindy://sessions/session-1?desktopEntry=0&desktopEntry=1&deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot'],
    ['不是伙伴资源', 'cindy://sessions/session-1?desktopEntry=1&deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=group'],
    ['缺少电脑', 'cindy://sessions/session-1?desktopEntry=1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot'],
    ['缺少伙伴集合', 'cindy://sessions/session-1?desktopEntry=1&deviceId=device-1&resourceId=bot-1&resourceKind=bot'],
    ['缺少伙伴 ID', 'cindy://sessions/session-1?desktopEntry=1&deviceId=device-1&resourceCollectionId=teammates&resourceKind=bot'],
    ['跳到伙伴资料页而不是对话', 'cindy://resources/teammates/bot-1?desktopEntry=1&deviceId=device-1'],
    ['会话路径多一层', 'cindy://sessions/session-1/messages?desktopEntry=1&deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot'],
    ['会话 ID 含空格', 'cindy://sessions/bad%20id?desktopEntry=1&deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot'],
    ['会话 ID 含斜杠', 'cindy://sessions/a%2Fb?desktopEntry=1&deviceId=device-1&resourceCollectionId=teammates&resourceId=bot-1&resourceKind=bot'],
  ])('丢弃%s', (_label, url) => {
    expect(parseDesktopEntryLink(url)).toBeNull();
  });
});

describe('桌面标题', () => {
  it.each([
    ['普通名字', 'Cindy', '新任务', 'Cindy'],
    ['去掉多余空白', '  Ada   Lovelace  ', '新任务', 'Ada Lovelace'],
    ['空名字退到兜底', '   ', '新任务', '新任务'],
    ['兜底也空时用品牌名', '', '', 'Cindy'],
    ['恰好达到上限不截断', '一二三四五六七八九十百千', 'x', '一二三四五六七八九十百千'],
    ['超出上限截断成一行', '一二三四五六七八九十百千万', 'x', '一二三四五六七八九十百…'],
    ['英文超长也截断', 'Maximilian Alexander', 'x', 'Maximilian…'],
    ['兜底同样受上限约束', '', '这是一个很长很长的新任务兜底名字', '这是一个很长很长的新任…'],
  ])('%s', (_label, value, fallback, expected) => {
    expect(desktopEntryTitle(value, fallback)).toBe(expected);
  });

  it('按用户看到的字符截断，不拆开 ZWJ emoji', () => {
    const family = '👨‍👩‍👧';
    expect(desktopEntryTitle(family.repeat(13), 'x')).toBe(`${family.repeat(11)}…`);
  });

  it('上限是给启动器留一行空间的常量', () => {
    expect(DESKTOP_ENTRY_TITLE_MAX).toBe(12);
    expect(Array.from(desktopEntryTitle('a'.repeat(40), 'x'))).toHaveLength(DESKTOP_ENTRY_TITLE_MAX);
  });
});

describe('头像回退到字', () => {
  it.each([
    ['emoji 头像原样使用', { kind: 'emoji', value: '🦊' }, 'Cindy', '🦊'],
    ['ZWJ emoji 取完整字形', { kind: 'emoji', value: '👨‍👩‍👧' }, 'Cindy', '👨‍👩‍👧'],
    ['预设 / 媒体头像用 fallbackText', { kind: 'media', value: 'cindy-media://x', fallbackText: '阿' }, 'Cindy', '阿'],
    ['头像没有内容时取名字首字并大写', { kind: 'media', value: 'cindy-media://x' }, 'bob', 'B'],
    ['中文名保留首字', null, '李雷', '李'],
    ['空名字留空，由原生回退应用图标', null, '   ', ''],
  ])('%s', (_label, avatar, name, expected) => {
    expect(desktopEntryGlyph(avatar, name)).toBe(expected);
  });

  it('头像签名跟着图标真正画出来的东西变', () => {
    const media = { kind: 'media' as const, value: 'a', fallbackText: '阿' };
    const signature = desktopEntryAvatarSignature(media, '阿明');
    expect(desktopEntryAvatarSignature({ ...media }, '阿明')).toBe(signature);
    // 底色、回退字、名字首字都真的画在图标上，任一变化都要让桌面重算。
    expect(desktopEntryAvatarSignature({ ...media, color: '#112233' }, '阿明')).not.toBe(signature);
    expect(desktopEntryAvatarSignature({ ...media, fallbackText: '贝' }, '阿明')).not.toBe(signature);
    expect(desktopEntryAvatarSignature({ kind: 'media', value: 'a' }, 'bob'))
      .not.toBe(desktopEntryAvatarSignature({ kind: 'media', value: 'a' }, 'alice'));
    // 只改电脑名 / 标题以外不改图的内容时不重算：同一位伙伴同一份头像得到同一个签名。
    expect(desktopEntryAvatarSignature({ kind: 'emoji', value: '🦊' }, '随便什么名字'))
      .toBe(desktopEntryAvatarSignature({ kind: 'emoji', value: '🦊' }, '另一个名字'));
    expect(desktopEntryAvatarSignature(null, '   ')).toBe('');
  });
});
