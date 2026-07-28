/**
 * QuickStartPillMark — 快速开始卡片预填文本的视觉胶囊标记。
 *
 * 当用户点击 New Maker 页面的快速开始卡片时，文本以本 mark 包裹写入编辑器，
 * 渲染为黑底白字的圆角胶囊（与 model selector 的"限时免费"徽章同风格），
 * 以区分「来自卡片的预填提示」和「用户手动输入的文字」。
 *
 * 设计约束：
 *   - 文档里文本仍是普通 text node + 本 mark；发送时序列化只取 textContent，
 *     mark 不产生任何额外输出（对 agent 透明）。
 *   - inclusive=false：用户在胶囊右侧继续输入时新文字不继承 mark，
 *     胶囊范围保持在原始预填文本上。
 *   - 用户 Backspace / 选删胶囊内文字时 mark 随文字一起消失，无需额外 plugin。
 */
import { Mark, mergeAttributes } from '@tiptap/core';

export const QuickStartPillMark = Mark.create({
  name: 'quickStartPill',

  // 不 inclusive：光标在 mark 边界输入时新字符不继承本 mark。
  inclusive: false,

  // 优先级低于内置 marks（如 bold），避免冲突。
  priority: 50,

  addAttributes() {
    return {};
  },

  parseHTML() {
    return [{ tag: 'span[data-quick-start-pill]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'quick-start-pill',
        'data-quick-start-pill': '',
      }),
      0,
    ];
  },
});
