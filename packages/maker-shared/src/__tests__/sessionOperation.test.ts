import { describe, expect, it } from 'vitest';
import {
  buildSessionComposerLayout,
  buildSessionOperationLayout,
  composerVoiceStateLabel,
} from '../sessionOperation.js';

describe('shared session operation model', () => {
  it('prioritizes missing session, remote unavailable, pending interaction, read-only, then editable composer', () => {
    expect(buildSessionOperationLayout({
      hasCurrentSession: false,
      hasActivePendingInteraction: true,
    })).toEqual({
      canUseComposer: false,
      composerDisabledReason: '当前任务还没有同步完成。',
      composerDisabledReasonSource: 'session-syncing',
      composerSlot: 'missing-session',
      messageHistoryMode: 'hidden',
      pendingInteractionPlacement: 'none',
      showPendingInteraction: false,
      showQueue: false,
    });

    expect(buildSessionOperationLayout({
      hasCurrentSession: true,
      hasActivePendingInteraction: true,
      remoteUnavailableReason: '网络或被控端暂时不可用，可以稍后重新同步。',
    })).toEqual({
      canUseComposer: false,
      composerDisabledReason: '网络或被控端暂时不可用，可以稍后重新同步。',
      composerDisabledReasonSource: 'caller-provided',
      composerSlot: 'editable',
      messageHistoryMode: 'visible',
      pendingInteractionPlacement: 'none',
      showPendingInteraction: false,
      showQueue: false,
    });

    expect(buildSessionOperationLayout({
      hasCurrentSession: true,
      hasActivePendingInteraction: true,
      readOnlyReason: '协作模式手机版第一版为只读安全降级。',
    })).toEqual({
      canUseComposer: false,
      composerDisabledReason: '先处理电脑端的待处理请求后才能继续输入。',
      composerDisabledReasonSource: 'pending-interaction',
      composerSlot: 'pending-interaction',
      messageHistoryMode: 'visible',
      pendingInteractionPlacement: 'composer',
      showPendingInteraction: true,
      showQueue: false,
    });

    expect(buildSessionOperationLayout({
      hasCurrentSession: true,
      hasActivePendingInteraction: false,
      readOnlyReason: '协作模式手机版第一版为只读安全降级。',
    })).toMatchObject({
      canUseComposer: false,
      composerDisabledReason: '协作模式手机版第一版为只读安全降级。',
      composerDisabledReasonSource: 'caller-provided',
      composerSlot: 'read-only',
      messageHistoryMode: 'visible',
      pendingInteractionPlacement: 'none',
      showQueue: true,
    });

    expect(buildSessionOperationLayout({
      hasCurrentSession: true,
      hasActivePendingInteraction: false,
    })).toEqual({
      canUseComposer: true,
      composerDisabledReason: null,
      composerDisabledReasonSource: null,
      composerSlot: 'editable',
      messageHistoryMode: 'visible',
      pendingInteractionPlacement: 'none',
      showPendingInteraction: false,
      showQueue: true,
    });
  });
});

describe('shared session composer action model', () => {
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
    expect(empty.input.placeholder).toBe('继续聊一聊…');
    expect(empty.statusText).toBe('就绪');

    const attachmentOnly = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 1,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '   ',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    });
    expect(attachmentOnly.primaryAction).toBe('send');
    expect(attachmentOnly.density).toBe('expanded');
    expect(attachmentOnly.send).toEqual({
      disabled: false,
      disabledReason: null,
      label: '发送',
      visible: true,
    });
    expect(attachmentOnly.statusText).toBe('就绪');
  });

  it('enables send for quote-only drafts (chat-text-quote)', () => {
    const quoteOnly = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '',
      queueBusy: false,
      quoteCount: 2,
      sending: false,
      voiceState: 'idle',
    });
    expect(quoteOnly.primaryAction).toBe('send');
    // 引用胶囊渲染在 composer 上方,compact 态会挤压布局 → 有引用即 expanded。
    expect(quoteOnly.density).toBe('expanded');
    expect(quoteOnly.send).toEqual({
      disabled: false,
      disabledReason: null,
      label: '发送',
      visible: true,
    });
    expect(quoteOnly.guidanceText).toBe('将发送 2 处引用，也可以补充说明后再发送。');
  });

  it('keeps send disabled while attachments are still uploading', () => {
    // 粘贴图片上传中(无系统 picker 遮挡、UI 完全可交互)抢发会发出不含该附件的
    // 消息并把图滞留托盘,attachmentBusy 必须挡发送。
    const uploading = buildSessionComposerLayout({
      attachmentBusy: true,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: 'send with pasted image',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    });
    expect(uploading.send).toEqual({
      disabled: true,
      disabledReason: '附件上传中，完成后再发送。',
      label: '发送',
      visible: true,
    });
    // 输入不受影响:上传期间仍可继续编辑草稿。
    expect(uploading.input.disabled).toBe(false);
  });

  it('keeps draft input editable while send is temporarily unavailable', () => {
    const layout = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: 'queued when online',
      queueBusy: false,
      sendUnavailableReason: '网络或被控端暂时不可用，可以稍后重新同步。',
      sending: false,
      voiceState: 'idle',
    });

    expect(layout.input).toMatchObject({
      disabled: false,
      disabledReason: null,
    });
    expect(layout.send).toEqual({
      disabled: true,
      disabledReason: '网络或被控端暂时不可用，可以稍后重新同步。',
      label: '发送',
      visible: true,
    });
    expect(layout.guidanceText).toBe('网络或被控端暂时不可用，可以稍后重新同步。');
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

    expect(layout.primaryAction).toBe('send');
    expect(layout.density).toBe('expanded');
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
    expect(layout.input.placeholder).toBe('正在听……');
    expect(layout.guidanceText).toBe('点发送会结束语音并发送当前文字；点输入框会结束语音并弹出键盘。');
    expect(layout.statusText).toBe('正在听');
  });

  it('uses stop as the primary action only when running without a draft or attachments', () => {
    const running = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: true,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    });
    expect(running.primaryAction).toBe('stop');
    expect(running.density).toBe('expanded');
    expect(running.send.visible).toBe(false);
    expect(running.stop).toEqual({
      disabled: false,
      disabledReason: null,
      label: '停止',
      visible: true,
    });
    expect(running.guidanceText).toBe('电脑端正在执行；可继续排队输入，或点停止保留当前队列。');
    expect(running.statusText).toBe('就绪');

    const runningWithDraft = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: true,
      draftText: 'continue with this',
      queueBusy: false,
      sending: false,
      voiceState: 'idle',
    });
    expect(runningWithDraft.primaryAction).toBe('send');
    expect(runningWithDraft.density).toBe('expanded');
    expect(runningWithDraft.send.visible).toBe(true);
    expect(runningWithDraft.stop).toEqual({
      disabled: false,
      disabledReason: null,
      label: '停止',
      visible: true,
    });
    expect(runningWithDraft.guidanceText).toBe('点发送后会进入桌面端队列，按当前任务设置执行。');
  });

  it('keeps the send slot present and usable through the whole voice lifecycle', () => {
    // 语音生命周期内发送槽常驻(对齐桌面主槽永远占位):转写落地前后布局不变,
    // 否则首段转写让发送键冒出来的瞬间,语音按钮整格左移、原位变成停止任务。
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

    // listening + 空草稿:发送可见且可按,语义是「结束录音并发送」(finish-and-send)。
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

    // submitting/refining + 空草稿:转写还没落地,发送保持可见但禁用,布局不塌。
    for (const voiceState of ['submitting', 'refining'] as const) {
      const processing = buildSessionComposerLayout({
        attachmentBusy: false,
        attachmentCount: 0,
        attachmentPickerOpen: false,
        canStop: false,
        draftText: '',
        queueBusy: false,
        sending: false,
        voiceState,
      });
      expect(processing.send).toMatchObject({
        disabled: true,
        disabledReason: '语音正在处理，完成后再发送。',
        visible: true,
      });
    }

    // 语音结束(done)且草稿仍空:发送槽随语音生命周期一起收场。
    const doneEmpty = buildSessionComposerLayout({
      attachmentBusy: false,
      attachmentCount: 0,
      attachmentPickerOpen: false,
      canStop: false,
      draftText: '',
      queueBusy: false,
      sending: false,
      voiceState: 'done',
    });
    expect(doneEmpty.send.visible).toBe(false);
  });

  it('marks busy operations with disabled reasons without changing layout shape', () => {
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

  it('keeps voice labels shared with the mobile native voice adapter', () => {
    expect(composerVoiceStateLabel('idle')).toBe('语音');
    expect(composerVoiceStateLabel('listening')).toBe('正在听');
    expect(composerVoiceStateLabel('submitting')).toBe('转写中');
    expect(composerVoiceStateLabel('refining')).toBe('正在润色');
    expect(composerVoiceStateLabel('done')).toBe('语音');
    expect(composerVoiceStateLabel('error')).toBe('语音出错');
  });
});
