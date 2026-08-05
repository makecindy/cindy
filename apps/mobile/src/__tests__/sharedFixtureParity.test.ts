import { describe, expect, it } from 'vitest';
import { SHARED_REMOTE_CONTROL_FIXTURE } from '@cindy/maker-shared/fixtures';
import { buildMobileMessageRenderItems } from '@/session/messageRenderModel';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import type { RemoteMessage } from '@/session/types';

describe('shared remote-control fixture parity', () => {
  it('normalizes desktop-like raw messages into the mobile render model', () => {
    const rawMessages = SHARED_REMOTE_CONTROL_FIXTURE.rawMessages as RemoteMessage[];
    const normalized = normalizeRemoteMessages(rawMessages);

    expect(normalized.map((message) => [message.key, message.kind, message.label])).toEqual([
      ['raw-user-1', 'user', 'user'],
      ['raw-thinking-1', 'thinking', 'thinking 2s'],
      ['raw-bash', 'tool', 'Bash'],
      ['raw-edit', 'tool', 'Edit'],
      ['raw-orca-empty', 'tool', 'mcp__orca_worker_bridge__send_to_lead'],
      ['raw-orca-detail', 'tool', 'read_lead'],
      ['raw-todo-1', 'tool', 'TodoWrite'],
      ['raw-mid', 'assistant', 'assistant'],
      ['raw-todo-2', 'tool', 'TodoWrite'],
      ['raw-final', 'assistant', 'assistant'],
      ['raw-ask-answered', 'ask_user', 'ask_user'],
      ['raw-plan', 'plan_review', 'plan_review:revised'],
      ['raw-system-context', 'system', 'system:context'],
    ]);

    const edit = normalized.find((message) => message.key === 'raw-edit');
    expect(edit?.diff).toMatchObject({
      filePath: '/repo/xdt-maker/apps/mobile/src/session/MessageRenderer.tsx',
      insertions: 1,
      deletions: 1,
    });
    expect(edit?.media?.map((media) => [media.kind, media.url, media.title])).toEqual([
      ['image', 'xdt-image://session-primary/chart.png', undefined],
      ['video', 'xdt-video://session-primary/demo.mp4', undefined],
      ['audio', 'xdt-audio://session-primary/voice.m4a', 'Voice note'],
    ]);

    expect(normalized.find((message) => message.key === 'raw-orca-empty')?.secondaryBody).toBeUndefined();
    expect(normalized.find((message) => message.key === 'raw-orca-detail')?.secondaryBody)
      .toBe(JSON.stringify({ ok: true, message: 'Lead replied: continue with UI parity.' }));
    expect(normalized.find((message) => message.key === 'raw-final')).toMatchObject({
      turnCostUsd: 0.042,
      turnCostIsEstimate: true,
    });
    expect(normalized.find((message) => message.key === 'raw-ask-answered')?.body)
      .toBe('Q: Deploy?\nA: yes\n\nQ: Notify?\nA: (skipped)');
  });

  it('builds stable mobile render groups from the same raw fixture', () => {
    const rawMessages = SHARED_REMOTE_CONTROL_FIXTURE.rawMessages as RemoteMessage[];
    const items = buildMobileMessageRenderItems(rawMessages);

    // 桌面共享实现把 plan/todo 卡渲染成顶层独立项(work_group 之后),不再作为 work_group 的子项;
    // tool 产出媒体(raw-edit 的 xdt_image/video/audio)提为独立 tool_media 项,同样不折进
    // work_group —— 它把原先单个 work_group 从媒体处劈成两段(前段 thinking+tool_group,
    // 后段中间正文 raw-mid),媒体本体留在折叠块外常驻可见。
    expect(items.map((item) => item.type)).toEqual([
      'message',
      'work_group',
      'tool_media',
      'work_group',
      'todo',
      'message',
      'message',
      'message',
      'message',
    ]);

    const group = items[1];
    expect(group.type).toBe('work_group');
    if (group.type !== 'work_group') return;
    expect(group.key).toBe('work-raw-thinking-1');
    expect(group.children.map((child) => child.type)).toEqual([
      'thinking',
      'tool_group',
    ]);

    // tool_media:key 派生自组首 tool(raw-bash),tools 只含产媒体的 raw-edit。
    const toolMedia = items[2];
    expect(toolMedia.type).toBe('tool_media');
    if (toolMedia.type !== 'tool_media') return;
    expect(toolMedia.key).toBe('media-raw-bash');
    expect(toolMedia.tools.map((tool) => tool.key)).toEqual(['raw-edit']);
    expect(toolMedia.tools[0].media?.map((media) => [media.kind, media.url])).toEqual([
      ['image', 'xdt-image://session-primary/chart.png'],
      ['video', 'xdt-video://session-primary/demo.mp4'],
      ['audio', 'xdt-audio://session-primary/voice.m4a'],
    ]);

    // 中间正文 raw-mid 被媒体项劈到第二段 work_group。
    const midGroup = items[3];
    expect(midGroup.type).toBe('work_group');
    if (midGroup.type !== 'work_group') return;
    expect(midGroup.children.map((child) => child.type)).toEqual(['message']);

    const toolGroup = group.children.find((child) => child.type === 'tool_group');
    expect(toolGroup?.type).toBe('tool_group');
    if (toolGroup?.type !== 'tool_group') return;
    expect(toolGroup.tools.map((tool) => [tool.key, tool.label, tool.secondaryBody])).toEqual([
      ['raw-bash', 'Bash', '303 tests passed'],
      ['raw-edit', 'Edit', JSON.stringify({
        ok: true,
        xdt_image_urls: ['xdt-image://session-primary/chart.png'],
        xdt_video_urls: ['xdt-video://session-primary/demo.mp4'],
        _xdt_audio_tracks: [
          { title: 'Voice note', xdt_audio_url: 'xdt-audio://session-primary/voice.m4a' },
        ],
      })],
      ['raw-orca-empty', 'mcp__orca_worker_bridge__send_to_lead', undefined],
      ['raw-orca-detail', 'read_lead', JSON.stringify({ ok: true, message: 'Lead replied: continue with UI parity.' })],
    ]);

    // todo 卡现在是顶层独立项(items[4]),不再是 work_group 的子项。
    const todo = items[4];
    expect(todo?.type).toBe('todo');
    if (todo?.type !== 'todo') return;
    expect(todo.key).toBe('todo-raw-todo-1');
    expect(todo.todos).toEqual([
      { content: '迁移 schedule model', status: 'completed', activeForm: undefined },
      { content: '抽取 device-link contract', status: 'completed', activeForm: undefined },
      { content: '补 raw desktop fixture', status: 'completed', activeForm: undefined },
    ]);
  });
});
