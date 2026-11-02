import { useEffect, useRef } from 'react';
import { useNativeState } from '@expo/ui/swift-ui';

/** 原生文本控件的可观察文本状态。`@expo/ui/swift-ui` 只导出 `useNativeState`，类型从它推导。 */
export type NativeTextState = ReturnType<typeof useNativeState<string>>;

/**
 * 原生文本控件持有正在输入的文字，也包括输入法尚未上屏的组字（拼音、假名等）。
 *
 * `onTextChange` 是异步事件：打字或组字时原生控件已经比它新，按「JS 值不同就回写」同步
 * 会把旧文本塞回控件。一次回写足以让 SwiftUI 重建字段、结束组字，未上屏的字母被直接
 * 提交进输入框。因此输入过程中一律只由原生控件决定文本，只有草稿被整体替换（重开表单、
 * 宿主重置、切换字段）时才把新值推给控件一次。
 *
 * 返回的 `onTextChange` 会先记下这次原生给出的文本，调用方再照常上报给 JS 草稿；随后的
 * 重渲染会认出这个值来自输入本身而不是替换，从而跳过回写。
 */
export function useNativeTextDraft(value: string, emit: (text: string) => void): {
  text: NativeTextState;
  onTextChange: (text: string) => void;
} {
  const text = useNativeState(value);
  // 最近一次由输入产生、已经存在于原生控件里的文本；与 `value` 相等即表示没有替换发生。
  const typed = useRef(value);
  useEffect(() => {
    if (value === typed.current) return;
    typed.current = value;
    text.set(value);
  }, [value, text]);
  return {
    text,
    onTextChange: (next: string) => {
      typed.current = next;
      emit(next);
    },
  };
}
