import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSessionComposerLayout } from '@/session/sessionComposerLayout';

const desktopZhLocale = JSON.parse(readFileSync(
  resolve(process.cwd(), '../desktop/src/renderer/i18n/locales/zh-CN/common.json'),
  'utf8',
)) as {
  ccAgent: {
    layout: {
      chatPlaceholder: string;
    };
  };
};

describe('sessionComposerLayout', () => {
  it('keeps send disabled until text or attachments exist', () => {
    const empty = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '   ',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    });
    expect(empty.primaryAction).toBe('none');
    expect(empty.density).toBe('compact');
    expect(empty.send).toEqual({
      disabled: true,
      disabledReason: '输入文字、添加附件或引用后才能发送。',
      label: '发送',
      visible: false,
    });
    expect(empty.guidanceText).toBe('输入文字开始，使用 / 调命令，使用 @ 引用项目资源。');
    expect(empty.input.placeholder).toBe(desktopZhLocale.ccAgent.layout.chatPlaceholder);
    expect(empty.statusText).toBe('就绪');

    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 1,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '   ',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    })).toMatchObject({
      density: 'expanded',
      send: {
        disabled: false,
        disabledReason: null,
        label: '发送',
        visible: true,
      },
    });
  });

  it('expands the composer once the user has context that needs explanation', () => {
    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: 'run tests',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).density).toBe('expanded');

    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: true,
      canStop: false,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).density).toBe('expanded');

    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: true,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).density).toBe('expanded');
  });

  it('keeps send enabled for attachment-only messages', () => {
    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 1,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '   ',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).send).toEqual({
      disabled: false,
      disabledReason: null,
      label: '发送',
      visible: true,
    });
  });

  it('keeps text editable while a deterministic remote error blocks sending', () => {
    const layout = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '等待重新授权后发送',
      queueBusy: false,
      sendUnavailableReason: '这台电脑已撤销手机访问权限。',
      sending: false,
      voiceState: 'idle',
    });

    expect(layout.input).toMatchObject({
      disabled: false,
      disabledReason: null,
    });
    expect(layout.send).toEqual({
      disabled: true,
      disabledReason: '这台电脑已撤销手机访问权限。',
      label: '发送',
      visible: true,
    });
    expect(layout.guidanceText).toBe('这台电脑已撤销手机访问权限。');
  });

  it('summarizes attachment and voice tool state for the compact mobile composer', () => {
    const layout = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 2,
      attachmentPickerOpen: true,
      canStop: true,
      draftText: 'hello',
      queueBusy: false,
      sending: false,
      voiceState: 'listening',
    });

    expect(layout.attachment).toEqual({
      active: true,
      disabled: false,
      disabledReason: null,
      label: '附件 2',
      remove: {
        disabled: false,
        disabledReason: null,
      },
    });
    expect(layout.voice).toEqual({
      active: true,
      disabled: false,
      disabledReason: null,
      label: '正在听',
    });
    expect(layout.stop).toEqual({
      disabled: false,
      disabledReason: null,
      label: '停止',
      visible: true,
    });
    expect(layout.primaryAction).toBe('send');
    expect(layout.input.placeholder).toBe('正在听……');
    expect(layout.guidanceText).toBe('点发送会结束语音并发送当前文字；点输入框会结束语音并弹出键盘。');
    expect(layout.statusText).toBe('正在听');
  });

  it('keeps the send slot present through the whole voice lifecycle', () => {
    // 语音生命周期内发送槽常驻(对齐桌面主槽永远占位,2026-07-25 定案):
    // listening 即使草稿空也可按(结束录音并发送),润色期禁用占位,布局不塌。
    const listening = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'listening',
    });

    expect(listening.send).toEqual({
      disabled: false,
      disabledReason: null,
      label: '发送',
      visible: true,
    });
    expect(listening.input).toMatchObject({
      disabled: false,
      disabledReason: null,
      placeholder: '正在听……',
    });
    expect(listening.guidanceText).toBe('正在听；点发送会结束语音并发送识别的文字，点输入框可结束语音并弹出键盘。');
    expect(listening.statusText).toBe('正在听');

    const refining = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'refining',
    });
    expect(refining.send).toMatchObject({
      disabled: true,
      disabledReason: '语音正在处理，完成后再发送。',
      visible: true,
    });
  });

  it('hides stop in the normal idle composer but keeps running work stoppable while send is primary', () => {
    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: 'run tests',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).stop).toEqual({
      disabled: true,
      disabledReason: '电脑端当前没有可停止的执行。',
      label: '停止',
      visible: false,
    });

    const runningEmpty = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: true,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    });
    expect(runningEmpty.primaryAction).toBe('stop');
    expect(runningEmpty.send.visible).toBe(false);
    expect(runningEmpty.stop).toEqual({
      disabled: false,
      disabledReason: null,
      label: '停止',
      visible: true,
    });

    const runningWithDraft = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: true,
      draftText: '继续排队',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    });
    expect(runningWithDraft.primaryAction).toBe('send');
    expect(runningWithDraft.send.visible).toBe(true);
    expect(runningWithDraft.stop).toEqual({
      disabled: false,
      disabledReason: null,
      label: '停止',
      visible: true,
    });
    expect(runningWithDraft.guidanceText).toBe('点发送后会进入桌面端队列，按当前任务设置执行。');
  });

  it('marks busy operations without changing the primary layout shape', () => {
    const layout = buildSessionComposerLayout({
      attachmentBusy: true,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: true,
      draftText: 'run tests',
      queueBusy: true,
      sending: true,
      voiceState: 'submitting',
    });

    expect(layout.attachment).toMatchObject({
      disabled: true,
      disabledReason: '附件处理中，完成后再继续添加。',
      label: '附件',
      remove: {
        disabled: true,
        disabledReason: '附件处理中，完成后再继续添加。',
      },
    });
    expect(layout.input).toMatchObject({
      disabled: true,
      disabledReason: '消息正在发送到电脑端。',
      placeholder: '正在转写语音',
    });
    expect(layout.voice).toMatchObject({
      disabled: true,
      disabledReason: '消息正在发送到电脑端，完成后再录音。',
      label: '转写中',
    });
    expect(layout.stop).toEqual({
      disabled: true,
      disabledReason: '队列操作同步中，暂时不能停止。',
      label: '处理中',
      visible: true,
    });
    expect(layout.send).toEqual({
      disabled: true,
      disabledReason: '消息正在发送到电脑端。',
      label: '发送中',
      visible: true,
    });
    expect(layout.guidanceText).toBe('消息正在写入桌面端队列，完成前请不要重复发送。');
    expect(layout.statusText).toBe('正在发送到电脑端');
  });

  it('shows composer status only for transient work, not normal ready states', () => {
    expect(buildSessionComposerLayout({
      attachmentBusy: true,
      attachmentCount: 0,
      attachmentPickerOpen: true,
      canStop: true,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).statusText).toBe('正在处理附件');

    const withAttachments = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 2,
      attachmentPickerOpen: false,
      canStop: true,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    });

    expect(withAttachments.input.placeholder).toBe(desktopZhLocale.ccAgent.layout.chatPlaceholder);
    expect(withAttachments.guidanceText).toBe('将只发送 2 个附件，也可以补充说明后再发送。');
    expect(withAttachments.statusText).toBe('就绪');

    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: true,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    })).toMatchObject({
      guidanceText: '电脑端正在执行；可继续排队输入，或点停止保留当前队列。',
      statusText: '就绪',
    });
  });

  it('explains attachment picker and draft-plus-attachment send behavior', () => {
    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: true,
      canStop: false,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).guidanceText).toBe('可以添加手机上的照片、截图或文件。');

    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 1,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: 'explain this',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).guidanceText).toBe('将发送 1 个附件和输入框里的文字。');

    expect(buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: 'run tests',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    }).guidanceText).toBe('点发送后会进入桌面端队列，按当前任务设置执行。');
  });
});
