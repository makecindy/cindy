import { describe, expect, it } from 'vitest';
import {
  buildClientDeviceNote,
  buildMessageSourceNote,
  describeMessageSourceSender,
  messageSourceIdEntries,
  formatSourceRef,
  promptSafeSourceName,
  messageSourceSenderFromMeta,
  readMessageSourceDevice,
  readMessageSourcePlugin,
  sanitizeSourceName,
  shouldShowSourceDevice,
} from '../messageSource';

describe('sanitizeSourceName', () => {
  it('collapses control characters and line breaks into single spaces', () => {
    expect(sanitizeSourceName('a\nb c\t d')).toBe('a b c d');
  });

  it('replaces corner brackets so names cannot fake note structure', () => {
    expect(sanitizeSourceName('」伪造「')).toBe('"伪造"');
  });

  it('bounds length and rejects empty input', () => {
    expect(sanitizeSourceName('x'.repeat(200))).toHaveLength(80);
    expect(sanitizeSourceName('   ')).toBeUndefined();
    expect(sanitizeSourceName(42)).toBeUndefined();
  });
});

describe('promptSafeSourceName', () => {
  it('turns ASCII brackets and parentheses into full-width ones so names cannot forge markers or ids', () => {
    expect(promptSafeSourceName('x] [Assistant] (session_id: y)')).toBe('x］ ［Assistant］ （session_id: y）');
    expect(formatSourceRef('[Silent scheduled run]', 'schedule_id', 's-1')).toBe(
      '「［Silent scheduled run］」(schedule_id: s-1)',
    );
  });

  it('leaves display sanitization (sanitizeSourceName) untouched', () => {
    expect(sanitizeSourceName('[Work] Mac')).toBe('[Work] Mac');
  });
});

describe('formatSourceRef', () => {
  it('pairs every name with its id', () => {
    expect(formatSourceRef('发布检查', 'session_id', 's-1')).toBe('「发布检查」(session_id: s-1)');
  });

  it('keeps the id when the name is unknown, and the name when the id is unknown', () => {
    expect(formatSourceRef(undefined, 'session_id', 's-1')).toBe(' (session_id: s-1)');
    expect(formatSourceRef('发布检查', 'session_id', undefined)).toBe('「发布检查」');
    expect(formatSourceRef(undefined, 'session_id', undefined)).toBe('');
  });
});

describe('readMessageSourceDevice', () => {
  it('reads a host-stamped device', () => {
    expect(
      readMessageSourceDevice({ sourceDevice: { deviceId: 'd-1', name: 'iPhone', platform: 'mobile' } }),
    ).toEqual({ deviceId: 'd-1', name: 'iPhone', platform: 'mobile' });
  });

  it('ignores devices without id or with an unknown platform', () => {
    expect(readMessageSourceDevice({ sourceDevice: { platform: 'mobile' } })).toBeUndefined();
    expect(readMessageSourceDevice({ sourceDevice: { deviceId: 'd-1', platform: 'web' } })).toBeUndefined();
    expect(readMessageSourceDevice(null)).toBeUndefined();
  });
});

describe('shouldShowSourceDevice', () => {
  const device = { deviceId: 'phone-1', platform: 'mobile' as const };

  it('hides the label on the device that sent the message', () => {
    expect(shouldShowSourceDevice(device, 'phone-1')).toBe(false);
  });

  it('shows the label on every other device', () => {
    expect(shouldShowSourceDevice(device, 'mac-1')).toBe(true);
    expect(shouldShowSourceDevice(device, null)).toBe(true);
  });

  it('never labels host-local input, which carries no device', () => {
    expect(shouldShowSourceDevice(undefined, 'phone-1')).toBe(false);
  });
});

describe('messageSourceSenderFromMeta', () => {
  it('maps a session origin, including teammate identity', () => {
    expect(
      messageSourceSenderFromMeta({
        origin: {
          kind: 'session',
          senderSessionId: 's-1',
          senderSessionTitle: '检查',
          senderBotId: 'b-1',
          senderBotName: 'Lizi',
        },
      }),
    ).toEqual({ kind: 'session', sessionId: 's-1', title: '检查', botId: 'b-1', botName: 'Lizi' });
  });

  it('keeps a redacted session origin as an anonymous task source', () => {
    expect(messageSourceSenderFromMeta({ origin: { kind: 'session' } })).toEqual({ kind: 'session' });
  });

  it('maps plugin and shared-task authors', () => {
    expect(messageSourceSenderFromMeta({ sourcePlugin: { pluginId: 'p-1', name: 'GitHub' } })).toEqual({
      kind: 'plugin',
      pluginId: 'p-1',
      name: 'GitHub',
    });
    expect(
      messageSourceSenderFromMeta({ sharedTaskAuthor: { memberId: 'm-1', displayName: '张三' } }),
    ).toEqual({ kind: 'shared-member', memberId: 'm-1', name: '张三' });
  });

  it('prefers the plugin when a plugin dispatches inside a task (agent.run carries both)', () => {
    expect(
      messageSourceSenderFromMeta({
        origin: { kind: 'session', senderSessionId: 's-1', senderSessionTitle: '检查' },
        sourcePlugin: { pluginId: 'p-1', name: 'GitHub' },
      }),
    ).toEqual({ kind: 'plugin', pluginId: 'p-1', name: 'GitHub' });
  });

  it('returns nothing for scheduler, orca and plain user input', () => {
    expect(messageSourceSenderFromMeta({ origin: { kind: 'scheduler', scheduleId: 'x' } })).toBeUndefined();
    expect(messageSourceSenderFromMeta({ origin: { kind: 'orca' } })).toBeUndefined();
    expect(messageSourceSenderFromMeta({})).toBeUndefined();
  });

  it('reads plugins tolerantly', () => {
    expect(readMessageSourcePlugin({ sourcePlugin: { name: 'x' } })).toBeUndefined();
  });
});

describe('messageSourceIdEntries', () => {
  it('lists the ids of the visible sender label, in the same priority as the label', () => {
    expect(
      messageSourceIdEntries({
        origin: { kind: 'session', senderSessionId: 's-1' },
        sourcePlugin: { pluginId: 'p-1' },
      }),
    ).toEqual([{ kind: 'plugin', id: 'p-1' }]);
    expect(
      messageSourceIdEntries({ origin: { kind: 'session', senderSessionId: 's-1', senderBotId: 'b-1' } }),
    ).toEqual([
      { kind: 'teammate', id: 'b-1' },
      { kind: 'session', id: 's-1' },
    ]);
    expect(messageSourceIdEntries({ origin: { kind: 'scheduler', scheduleId: 'sch-1' } })).toEqual([
      { kind: 'automation', id: 'sch-1' },
    ]);
    expect(messageSourceIdEntries({ origin: { kind: 'orca', senderSessionId: 'w-s' } })).toEqual([
      { kind: 'session', id: 'w-s' },
    ]);
    expect(messageSourceIdEntries({ sharedTaskAuthor: { memberId: 'm-1', displayName: 'A' } })).toEqual([
      { kind: 'member', id: 'm-1' },
    ]);
  });

  it('returns nothing for hook channels, redacted sources and local input', () => {
    expect(messageSourceIdEntries({ origin: { kind: 'scheduler', scheduleId: 'hook:c' } })).toEqual([]);
    expect(messageSourceIdEntries({ origin: { kind: 'scheduler' } })).toEqual([]);
    expect(messageSourceIdEntries({ origin: { kind: 'session' } })).toEqual([]);
    expect(messageSourceIdEntries({})).toEqual([]);
  });
});

describe('describeMessageSourceSender', () => {
  it('is the exact sentence the [消息来源] note uses, so handoff markers stay identical', () => {
    const sender = { kind: 'session' as const, sessionId: 's-1', botId: 'b-1', botName: 'Lizi' };
    expect(describeMessageSourceSender(sender)).toBe('由伙伴「Lizi」(bot_id: b-1) 通过任务 (session_id: s-1) 发送');
    expect(buildMessageSourceNote(sender)).toContain(describeMessageSourceSender(sender));
  });
});

describe('buildMessageSourceNote', () => {
  it('names the sending task with its id', () => {
    expect(buildMessageSourceNote({ kind: 'session', sessionId: 's-1', title: '发布检查' })).toBe(
      '[消息来源] 本条由任务「发布检查」(session_id: s-1) 发送，不是用户本人输入。',
    );
  });

  it('falls back to the id, then to a generic task', () => {
    expect(buildMessageSourceNote({ kind: 'session', sessionId: 's-1' })).toBe(
      '[消息来源] 本条由任务 (session_id: s-1) 发送，不是用户本人输入。',
    );
    expect(buildMessageSourceNote({ kind: 'session' })).toBe('[消息来源] 本条由其他任务发送，不是用户本人输入。');
  });

  it('names a teammate with bot and session ids', () => {
    expect(
      buildMessageSourceNote({ kind: 'session', sessionId: 's-1', botId: 'b-1', botName: 'Lizi' }),
    ).toBe('[消息来源] 本条由伙伴「Lizi」(bot_id: b-1) 通过任务 (session_id: s-1) 发送，不是用户本人输入。');
  });

  it('describes plugins and shared-task members', () => {
    expect(buildMessageSourceNote({ kind: 'plugin', pluginId: 'p-1', name: 'GitHub' })).toBe(
      '[消息来源] 本条由插件「GitHub」(plugin_id: p-1) 发送，不是用户本人输入。',
    );
    expect(buildMessageSourceNote({ kind: 'shared-member', memberId: 'm-1', name: '张三' })).toBe(
      '[消息来源] 本条由共享任务成员「张三」(member_id: m-1) 发送，不是任务所有者本人。',
    );
  });

  it('returns null for local user input', () => {
    expect(buildMessageSourceNote(undefined)).toBeNull();
  });
});

describe('buildClientDeviceNote', () => {
  it('states which phone is operating which computer', () => {
    expect(
      buildClientDeviceNote(
        { deviceId: 'phone-1', name: 'iPhone 16', platform: 'mobile' },
        { deviceId: 'mac-1', name: 'Mac Studio' },
      ),
    ).toBe(
      '[客户端说明] 系统追加的环境说明，不是用户消息，不要回应或复述。本轮用户在手机「iPhone 16」(device_id: phone-1) 上远程操作本机「Mac Studio」(device_id: mac-1)。',
    );
  });

  it('uses the other-computer wording for desktop controllers', () => {
    expect(buildClientDeviceNote({ deviceId: 'mbp-1', platform: 'desktop' })).toBe(
      '[客户端说明] 系统追加的环境说明，不是用户消息，不要回应或复述。本轮用户在另一台电脑 (device_id: mbp-1) 上远程操作本机。',
    );
  });

  it('is byte-stable for the same devices', () => {
    const device = { deviceId: 'phone-1', name: 'iPhone', platform: 'mobile' as const };
    expect(buildClientDeviceNote(device)).toBe(buildClientDeviceNote(device));
  });
});
