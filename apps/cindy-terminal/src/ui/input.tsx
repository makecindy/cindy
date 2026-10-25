import React, { useRef, useState } from 'react';
import { Text, useInput, usePaste, useWindowSize } from 'ink';
import wrapAnsi from 'wrap-ansi';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemes(value: string): string[] { return Array.from(segmenter.segment(value), part => part.segment); }
export function terminalText(value: string): string {
  // Strip OSC/DCS/CSI before C0; removing only ESC would expose their payload.
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P_X^][\s\S]*?\x1b\\/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function Input({ value, onChange, onSubmit, onCancel, secret = false, multiline = false, active = true }: {
  value: string; onChange: (value: string) => void; onSubmit: (value: string) => void;
  onCancel?: () => void; secret?: boolean; multiline?: boolean; active?: boolean;
}) {
  const [cursor, setCursor] = useState(() => graphemes(value).length);
  const {columns,rows}=useWindowSize();
  // Keypresses and pasted input can arrive together before React paints. Keep
  // the editing buffer synchronous so Enter cannot submit an earlier frame.
  const buffer = useRef({ value, cursor });
  buffer.current = { value, cursor };
  const chars = graphemes(value);
  const position = Math.min(cursor, chars.length);
  function move(next: number) { buffer.current.cursor = next; setCursor(next); }
  function change(next: string, nextCursor: number) {
    buffer.current = { value: next, cursor: nextCursor }; onChange(next); setCursor(nextCursor);
  }
  function insert(text: string) {
    const { value, cursor } = buffer.current;
    const chars = graphemes(value);
    const position = Math.min(cursor, chars.length);
    const clean = terminalText(text.replace(/\r\n?/g, '\n'));
    const textChars = graphemes(multiline ? clean : clean.replaceAll('\n', ' '));
    if (value.length + clean.length > 1024 * 1024) return;
    change([...chars.slice(0, position), ...textChars, ...chars.slice(position)].join(''), position + textChars.length);
  }
  usePaste(insert, { isActive: active });
  useInput((text, key) => {
    const { value, cursor } = buffer.current;
    const chars = graphemes(value);
    const position = Math.min(cursor, chars.length);
    if (key.eventType === 'release') return;
    if (key.escape) { onCancel?.(); return; }
    if (key.return) { if (multiline && (key.meta || key.shift)) insert('\n'); else onSubmit(value); return; }
    if (key.leftArrow) { move(Math.max(0, position - 1)); return; }
    if (key.rightArrow) { move(Math.min(chars.length, position + 1)); return; }
    if (key.home || (key.ctrl && text === 'a')) { move(0); return; }
    if (key.end || (key.ctrl && text === 'e')) { move(chars.length); return; }
    if (key.backspace || key.delete) {
      let nextCursor = position;
      if (key.backspace && position > 0) { chars.splice(position - 1, 1); nextCursor--; }
      else if (key.delete) chars.splice(position, 1);
      change(chars.join(''), nextCursor); return;
    }
    if (key.ctrl && text === 'u') { change(chars.slice(position).join(''), 0); return; }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
    insert(text);
  }, { isActive: active });
  const display = secret ? chars.map(() => '•') : chars;
  const before=display.slice(0,position).join('');
  const at=display[position]||' ';
  const after=display.slice(position+1).join('');
  const width=Math.max(8,columns-2),height=multiline?Math.max(2,Math.min(5,Math.floor(rows/4))):3;
  const cursorLine=wrapAnsi(before+(at==='\n'?' ':at),width,{hard:true,trim:false}).split('\n').length-1;
  const lines=wrapAnsi(`${before}${active?'\x1b[7m':''}${at==='\n'?' ':at}${active?'\x1b[27m':''}${at==='\n'?'\n':''}${after}`,width,{hard:true,trim:false}).split('\n');
  const start=Math.max(0,cursorLine-height+1);
  return <Text>{lines.slice(start,start+height).join('\n')}</Text>;
}
