import { forwardRef, type TextareaHTMLAttributes, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import {
  computeTextareaBackspace,
  computeTextareaContinuation,
  type TextareaListEdit,
} from '@/lib/composerListTextarea';
import { computePairedSelectionEdit, type PairedSelectionEdit } from '@/lib/pairedSelection';

/**
 * ListComposerTextarea —— 原生 `<textarea>` 的直替换包装,统一附带 composer
 * 列表输入辅助(Shift/Alt+Enter 序号接续、空列表项一次退格整删),并默认启用
 * `tabular-nums` 让多行序号对齐。
 *
 * 设计目标是"写一次、到处一行接入":列表逻辑集中在这里(纯逻辑复用
 * `lib/composerListTextarea`),各消费方只需把 `<textarea .../>` 换成
 * `<ListComposerTextarea .../>`,原有 props(value / onChange / onKeyDown /
 * ref / disabled / className …)原样透传、发送与取消等行为完全不变。
 *
 * 交互契约:
 * - 仅拦截"命中列表场景"的 Shift/Alt+Enter 与无修饰 Backspace;未命中时不
 *   preventDefault,继续交给调用方的 onKeyDown(如 Enter=发送)与浏览器默认
 *   行为,因此对非列表输入零副作用。
 * - 命中列表编辑时通过原生 value setter + 派发 input 事件回吐给受控父组件的
 *   onChange(React 受控组件标准写法),再恢复光标,父组件无需改 onChange。
 */

type ListComposerTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * 把一次列表编辑应用到受控 textarea:走原生 value setter 触发 React 的
 * onChange(直接改 el.value 不会触发受控更新),再把光标恢复到编辑落点。
 */
/** 受控 value setter 绕过原生 maxlength;列表接续 / 换行插入前先核对不超过 maxLength。 */
function withinMaxLength(el: HTMLTextAreaElement, next: string): boolean {
  return el.maxLength < 0 || next.length <= el.maxLength;
}

/** 在光标 / 选区处插入一个换行(替换选区),返回替换后的文本与折叠光标。 */
function plainNewlineEdit(value: string, selStart: number, selEnd: number): TextareaListEdit {
  return { value: value.slice(0, selStart) + '\n' + value.slice(selEnd), caret: selStart + 1 };
}

function applyEdit(el: HTMLTextAreaElement, edit: TextareaListEdit): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (setter) {
    setter.call(el, edit.value);
  } else {
    el.value = edit.value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.setSelectionRange(edit.caret, edit.caret);
}

function applyPairedSelectionEdit(
  el: HTMLTextAreaElement,
  edit: PairedSelectionEdit,
  direction: 'forward' | 'backward' | 'none',
): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(el, edit.value);
  else el.value = edit.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.setSelectionRange(edit.selectionStart, edit.selectionEnd, direction);
}

export const ListComposerTextarea = forwardRef<HTMLTextAreaElement, ListComposerTextareaProps>(
  function ListComposerTextarea({ onKeyDown, className, ...rest }, ref) {
    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const el = event.currentTarget;
      const selStart = el.selectionStart;
      const selEnd = el.selectionEnd;
      // IME 组字过程中的按键不介入;selectionStart/End 理论上对 textarea 恒非空,
      // 仍显式守卫(类型为 number | null)以满足 strictNullChecks 并让意图清晰。
      if (!event.nativeEvent.isComposing && selStart !== null && selEnd !== null) {
        const noHardMods = !event.metaKey && !event.ctrlKey;
        const pairedEdit = noHardMods
          ? computePairedSelectionEdit(el.value, selStart, selEnd, event.key)
          : null;
        if (pairedEdit) {
          event.preventDefault();
          if (withinMaxLength(el, pairedEdit.value)) {
            applyPairedSelectionEdit(el, pairedEdit, el.selectionDirection);
          }
          return;
        }
        // Shift/Alt+Enter — 列表接续 / 空项退出。
        if (event.key === 'Enter' && (event.shiftKey || event.altKey) && noHardMods) {
          const edit = computeTextareaContinuation(el.value, selStart, selEnd);
          // 超过 maxLength 不接续(受控 setter 绕过原生 maxlength,否则可能撑过共享上限
          // 被派发方判 bad-prompt 丢文本,如 Ghost 卡片 prompt)。
          if (edit && withinMaxLength(el, edit.value)) {
            event.preventDefault();
            applyEdit(el, edit);
            return;
          }
          // Alt+Enter 一律作为换行消费,绝不下沉到消费方的"Enter=发送"(多数消费方只排除
          // shiftKey,Alt+Enter 会被误当发送)。Shift+Enter 未命中列表时维持原行为(交默认 / 消费方)。
          if (event.altKey) {
            event.preventDefault();
            const nl = plainNewlineEdit(el.value, selStart, selEnd);
            if (withinMaxLength(el, nl.value)) applyEdit(el, nl);
            return;
          }
        }
        // Backspace(无修饰)— 空列表项整体回删。
        else if (event.key === 'Backspace' && noHardMods && !event.altKey && !event.shiftKey) {
          const edit = computeTextareaBackspace(el.value, selStart, selEnd);
          if (edit) {
            event.preventDefault();
            applyEdit(el, edit);
            return;
          }
        }
      }
      // 未处理列表场景:交还给调用方原有的键盘逻辑(Enter=发送 / Esc=取消 等)。
      onKeyDown?.(event);
    };

    return (
      <textarea
        ref={ref}
        onKeyDown={handleKeyDown}
        // tabular-nums:等宽数字,让多行 "1./2./3." 的点竖直对齐(与 ChatInput 一致)。
        className={cn('tabular-nums', className)}
        {...rest}
      />
    );
  },
);
