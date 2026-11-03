import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import { describe, expect, it } from 'vitest';

import { projectConversationShareMessage } from '@/session/conversationShareProjection';

describe('projectConversationShareMessage', () => {
  it('按消息收起态投影正文，不把隐藏后续内容带进分享图', () => {
    const projected = projectConversationShareMessage('collapsed', {
      body: '第一行\n第二行\n隐藏的第三行\n隐藏的第四行',
      kind: 'user',
    }, { maxVisibleLines: 2 });

    expect(projected?.body).toBe('第一行\n第二行');
    expect(JSON.stringify(projected)).not.toContain('隐藏的第三行');
  });

  it('分享图不带任何消息来源：自动化、设备、插件与共享任务作者都不进投影', () => {
    const message = {
      automationOrigin: { scheduleId: 'schedule-secret', scheduleName: '每日摘要' },
      body: '自动化消息',
      kind: 'user' as const,
      sessionOrigin: { senderSessionId: 'sender-secret', senderSessionTitle: '来源任务' },
      sourceDevice: { deviceId: 'device-secret', name: '我的 iPhone', platform: 'mobile' as const },
      sourcePlugin: { pluginId: 'plugin-secret', name: '日报插件' },
      sharedAuthorName: '访客甲',
    };
    const projected = projectConversationShareMessage('automation', message);

    expect(projected).toEqual({ body: '自动化消息', clientId: 'automation', kind: 'user' });
    for (const hidden of ['schedule-secret', '每日摘要', '来源任务', 'device-secret', '我的 iPhone', '日报插件', '访客甲']) {
      expect(JSON.stringify(projected)).not.toContain(hidden);
    }
  });

  it('把引用投影为紧凑可见 chip，并丢弃隐藏来源字段', () => {
    const body = formatQuoteForSend({
      sourcePath: '/private/project/secret.ts',
      text: 'quoted\n  context',
    });

    const projected = projectConversationShareMessage('quote-only', {
      body,
      kind: 'user',
      quotesEncoded: true,
    });

    expect(projected?.bodyParts).toEqual([
      { kind: 'quote', label: 'quoted context' },
    ]);
    expect(JSON.stringify(projected)).not.toContain(
      '/private/project/secret.ts',
    );
  });

  it('保留图片读取地址和附件顺序，但不带入普通文件的本机路径', () => {
    const projected = projectConversationShareMessage('attachments', {
      attachments: [
        {
          kind: 'file',
          name: 'notes.md',
          path: '/private/project/notes.md',
          previewable: false,
        },
        {
          kind: 'image',
          name: 'inline.png',
          previewable: true,
          uri: 'data:image/png;base64,AA==',
        },
        {
          kind: 'image',
          name: 'remote.png',
          previewable: true,
          uri: 'https://example.com/private.png',
        },
      ],
      body: '',
      kind: 'user',
    });

    expect(projected?.attachments).toEqual([
      { kind: 'image', name: 'inline.png', uri: 'data:image/png;base64,AA==' },
      { kind: 'image', name: 'remote.png', uri: 'https://example.com/private.png' },
      { kind: 'file', name: 'notes.md' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('/private/project');
  });
});
