/**
 * voiceInputDraftDecoration.test.ts — 语音草稿装饰的"反闪动契约"回归测试
 * ---------------------------------------------------------------------------
 * 背景:多行语音草稿在润色 token 流式更新时出现"换行后文字概率性闪动"。根因是
 * 鬼文字 widget 的 key 含 text,每个 token 都让 ProseMirror 判定 widget 不相等,
 * 销毁重建整个 DOM 节点 → 浏览器对换行后所有行重排重绘(叠加相邻动画 caret 的
 * 合成层后被放大成可见闪动)。
 *
 * 修复后的契约(本测试在 ProseMirror state 层锁死,无需挂载真实编辑器):
 *   1. draft widget 的 key 与 text / source 无关 → 流式更新跨版本相等。
 *      prosemirror-view `WidgetType.eq` 的判定就是 `spec.key` 相同即相等
 *      (见其 dist 源码),key 稳定 ⇒ DOM 节点保留 ⇒ 不整段重绘。
 *   2. caret widget 的 key 与 text 无关,仅随 caretState / 锚点位置变化
 *      (切换图形时才允许重建;流式 token 不得打断其 CSS 动画)。
 *   3. plugin view 把流式 text / source 原地同步进存活节点(textContent 赋值,
 *      浏览器只重绘真正变化的字形)。
 *   4. caret-only(尚无草稿字)阶段 decoration 仍存在;text 与 caretState 都空
 *      则为空集。
 *   5. setVoiceInputDraftDecoration 对相同入参去重,不重复 dispatch(热路径)。
 *
 * META_KEY 字面量与实现保持一致;若实现改名,本测试同步失败提醒更新——有意为之。
 */
import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
  createVoiceInputDraftPlugin,
  setVoiceInputDraftDecoration,
  type VoiceInputCaretState,
} from '../components/new-chat/VoiceInputDraftDecoration';

const META_KEY = 'voiceInputDraftDecoration';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
});

function makeState(textContent: string) {
  const plugin = createVoiceInputDraftPlugin();
  const paragraph = schema.nodes.paragraph.create(
    null,
    textContent ? schema.text(textContent) : undefined,
  );
  const doc = schema.nodes.doc.create(null, [paragraph]);
  const state = EditorState.create({ schema, doc, plugins: [plugin] });
  return { plugin, state };
}

type DraftMeta = {
  text: string;
  source: 'partial' | 'stable' | 'refinement' | null;
  from: number;
  to: number;
  anchorLocked?: boolean;
  caretState?: VoiceInputCaretState | null;
};

function applyDraftMeta(state: EditorState, meta: DraftMeta): EditorState {
  return state.apply(
    state.tr.setMeta(META_KEY, {
      anchorLocked: true,
      caretState: null,
      ...meta,
    }),
  );
}

function widgetKeys(plugin: ReturnType<typeof createVoiceInputDraftPlugin>, state: EditorState) {
  const decorations = plugin.getState(state)?.decorations;
  const keys = (decorations?.find() ?? [])
    .map((deco) => (deco.spec as { key?: string }).key)
    .filter((key): key is string => typeof key === 'string');
  return {
    draft: keys.find((key) => key.startsWith('voice-input-draft:')) ?? null,
    caret: keys.find((key) => key.startsWith('voice-input-caret:')) ?? null,
  };
}

describe('voice input draft decoration anti-flicker contract', () => {
  it('keeps the draft widget key stable across streamed text and source updates', () => {
    const { plugin, state } = makeState('前文');
    const listening = applyDraftMeta(state, {
      text: '第一段',
      source: 'partial',
      from: 1,
      to: 1,
      caretState: 'listening',
    });
    const moreText = applyDraftMeta(listening, {
      text: '第一段 第二段更长的内容',
      source: 'partial',
      from: 1,
      to: 1,
      caretState: 'listening',
    });
    const stable = applyDraftMeta(moreText, {
      text: '第一段 第二段更长的内容',
      source: 'stable',
      from: 1,
      to: 1,
      caretState: 'listening',
    });

    const first = widgetKeys(plugin, listening);
    const second = widgetKeys(plugin, moreText);
    const third = widgetKeys(plugin, stable);
    expect(first.draft).not.toBeNull();
    // text 变化、source 变化都不得换 key —— key 一变 ProseMirror 就重建 DOM,
    // 多行草稿的换行后整段重绘就是闪动来源。
    expect(second.draft).toBe(first.draft);
    expect(third.draft).toBe(first.draft);
    // caret 同样跨流式更新保持稳定,CSS 动画不被打断。
    expect(second.caret).toBe(first.caret);
    expect(third.caret).toBe(first.caret);
  });

  it('keeps keys stable across refinement preview tokens over a replaced range', () => {
    const { plugin, state } = makeState('这是已经上屏的一段较长的听写文字');
    const range = { from: 1, to: 1 + '这是已经上屏的一段较长的听写文字'.length };
    const token1 = applyDraftMeta(state, {
      text: '这是润色后',
      source: 'refinement',
      ...range,
      caretState: 'processing',
    });
    const token2 = applyDraftMeta(token1, {
      text: '这是润色后更完整的预览文本',
      source: 'refinement',
      ...range,
      caretState: 'processing',
    });

    const first = widgetKeys(plugin, token1);
    const second = widgetKeys(plugin, token2);
    expect(first.draft).not.toBeNull();
    expect(second.draft).toBe(first.draft);
    expect(second.caret).toBe(first.caret);
  });

  it('recreates the caret widget only when caretState switches', () => {
    const { plugin, state } = makeState('前文');
    const listening = applyDraftMeta(state, {
      text: '草稿',
      source: 'partial',
      from: 1,
      to: 1,
      caretState: 'listening',
    });
    const processing = applyDraftMeta(listening, {
      text: '草稿',
      source: 'partial',
      from: 1,
      to: 1,
      caretState: 'processing',
    });
    expect(widgetKeys(plugin, listening).caret).not.toBe(widgetKeys(plugin, processing).caret);
  });

  it('renders a caret-only decoration before the first partial, and nothing when idle', () => {
    const { plugin, state } = makeState('前文');
    const caretOnly = applyDraftMeta(state, {
      text: '',
      source: null,
      from: 1,
      to: 1,
      caretState: 'listening',
    });
    expect(widgetKeys(plugin, caretOnly)).toEqual({
      draft: null,
      caret: expect.stringContaining('voice-input-caret:listening:'),
    });

    const idle = applyDraftMeta(caretOnly, {
      text: '',
      source: null,
      from: 1,
      to: 1,
      caretState: null,
    });
    expect(plugin.getState(idle)?.decorations.find()).toHaveLength(0);
  });

  it('syncs streamed text and source into the existing widget DOM in place', () => {
    const { plugin, state } = makeState('前文');
    const updated = applyDraftMeta(state, {
      text: '新的流式文本',
      source: 'stable',
      from: 1,
      to: 1,
      caretState: 'listening',
    });

    // 最小化伪造 EditorView:plugin view 只消费 state 与 dom.querySelector。
    const node = { textContent: '旧文本', dataset: {} as Record<string, string | undefined> };
    const fakeView = {
      state: updated,
      dom: {
        querySelector: (selector: string) =>
          selector === '[data-voice-draft-inline="true"]' ? node : null,
      },
    } as unknown as EditorView;

    const pluginView = plugin.spec.view!(fakeView);
    pluginView.update!(fakeView, state);
    expect(node.textContent).toBe('新的流式文本');
    expect(node.dataset.voiceDraftSource).toBe('stable');

    // source 清空时,已写入的 dataset 标记也要原地移除。
    const cleared = applyDraftMeta(updated, {
      text: '新的流式文本',
      source: null,
      from: 1,
      to: 1,
      caretState: 'listening',
    });
    (fakeView as { state: EditorState }).state = cleared;
    pluginView.update!(fakeView, updated);
    expect(node.dataset.voiceDraftSource).toBeUndefined();
  });

  // 录音期间输入框文档被整段重建(外部草稿通知走 setContent → replace(0, size))时,
  // 折叠锚点跨整篇映射会被推到 block 边界:widget 的 pos 落在 doc 层,ProseMirror 就
  // 把这个 inline span 渲染到 <p> 外面,浏览器给它单独一行 —— 表现为"第一句话出现前
  // 先多一个换行"。锚点必须留在段落内的 inline 位置。
  it('keeps the caret anchor inside the paragraph when the document is rebuilt wholesale', () => {
    const { plugin, state } = makeState('');
    const listening = applyDraftMeta(state, {
      text: '',
      source: null,
      from: 1,
      to: 1,
      caretState: 'listening',
    });
    expect(plugin.getState(listening)).toMatchObject({ from: 1, to: 1 });

    const rebuilt = listening.apply(
      listening.tr.replaceWith(
        0,
        listening.doc.content.size,
        schema.nodes.paragraph.create(),
      ),
    );
    const anchor = plugin.getState(rebuilt);
    expect(anchor).toMatchObject({ from: 1, to: 1 });
    const widget = plugin.getState(rebuilt)?.decorations.find()[0];
    expect(widget?.from).toBe(1);
    expect(rebuilt.doc.resolve(widget!.from).parent.isTextblock).toBe(true);
  });

  it('keeps a collapsed anchor collapsed across a full-document replacement', () => {
    const { plugin, state } = makeState('已经上屏的文字');
    const listening = applyDraftMeta(state, {
      text: '流式草稿',
      source: 'partial',
      from: 1 + '已经上屏的文字'.length,
      to: 1 + '已经上屏的文字'.length,
      caretState: 'listening',
    });
    const rebuilt = listening.apply(
      listening.tr.replaceWith(
        0,
        listening.doc.content.size,
        schema.nodes.paragraph.create(null, schema.text('已经上屏的文字')),
      ),
    );
    const anchor = plugin.getState(rebuilt);
    // 膨胀成区间会让 voice-input-draft-replaced 把正文整段 display:none 隐藏掉。
    expect(anchor?.from).toBe(anchor?.to);
    expect(rebuilt.doc.resolve(anchor!.from).parent.isTextblock).toBe(true);
  });

  it('deduplicates identical setVoiceInputDraftDecoration calls without dispatching', () => {
    const { state } = makeState('前文');
    let current = state;
    let dispatches = 0;
    const fakeEditor = {
      isDestroyed: false,
      get state() {
        return current;
      },
      view: {
        dispatch(tr: Parameters<EditorState['apply']>[0]) {
          dispatches += 1;
          current = current.apply(tr);
        },
      },
    } as unknown as Editor;

    setVoiceInputDraftDecoration(fakeEditor, '草稿', 'partial', { from: 1, to: 1 }, 'listening');
    expect(dispatches).toBe(1);
    // 入参完全相同的重复调用(ChatInput effect 重跑的常态)不得再次 dispatch。
    setVoiceInputDraftDecoration(fakeEditor, '草稿', 'partial', { from: 1, to: 1 }, 'listening');
    expect(dispatches).toBe(1);
    setVoiceInputDraftDecoration(fakeEditor, '草稿更新', 'partial', { from: 1, to: 1 }, 'listening');
    expect(dispatches).toBe(2);
  });
});
