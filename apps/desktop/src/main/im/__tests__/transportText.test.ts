/**
 * @cindy/im 传输层文案接到桌面端界面语言:resolver 按当前语言现取,缺 key 返回 null
 * 让传输层落回内置中文。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { setMainLocale } from '../../i18n.desktop';
import { resolveTransportText } from '../transportText';

afterEach(() => {
  setMainLocale('en');
});

describe('IM transport text resolver', () => {
  it('follows the current main-process locale and fills variables', () => {
    setMainLocale('zh-CN');
    expect(resolveTransportText('imBot.text.transport.feishu.lifecycle.online')).toBe('🟢 已上线，可以开聊啦~');
    setMainLocale('en');
    expect(resolveTransportText('imBot.text.transport.feishu.lifecycle.online')).toBe("🟢 I'm online. Let's talk!");
    expect(resolveTransportText('imBot.text.transport.feishu.streaming.partNoteMore', { index: 2, total: 3 })).toBe(
      '2/3 · continued in next message',
    );
    expect(resolveTransportText('imBot.text.transport.wecom.attachmentsOmitted', { count: 1, max: 4 })).toBe(
      "⚠️ 1 more attachment wasn't sent (WeCom sends at most 4 at a time).",
    );
    expect(resolveTransportText('imBot.text.transport.wecom.attachmentsOmitted', { count: 2, max: 4 })).toBe(
      "⚠️ 2 more attachments weren't sent (WeCom sends at most 4 at a time).",
    );
  });

  it('returns null for unknown keys so the transport keeps its built-in copy', () => {
    expect(resolveTransportText('imBot.text.transport.nope')).toBeNull();
    expect(resolveTransportText('imBot.text.transport.nope', { count: 2 })).toBeNull();
  });
});
