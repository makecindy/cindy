import { useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

export type CardSummaryProps = {
  summary?: string;
  /** Existing archives call this field summary; empty restores the derived node name. */
  onSummaryChange?: (summary: string) => void;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function excerpt(text: string) {
  let result = '', count = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (++count > 10) break;
    result += segment;
  }
  return result;
}

const words = new Intl.Segmenter('zh', { granularity: 'word' });
const filler = /^(?:我|你|这|那|有|要|是|能|该|的|了|下|就|会|在|和|与|中|一个|这个|那个|可以|现在|需要|不同|应该|情况|一下|关于|问题是|请问|选|做|怎么办|多久|选择|解决|修改|比较|给|结论|改法|please|i|we|a|an|the|on|in|of|my|your|is|are|and|or|does|do|can|with|why|how|what|fix|explain)$/iu;
function nodeName(question: string) {
  const plain = question.trim().replace(/^[#>\s]+|[`*]/gu, '').replace(/^\w+\s*·\s*/u, '')
    .replace(/页面/gu, '页').replace(/(?:水平|横向)滚动(?:条)?/gu, '横滚')
    .replace(/(\S)在[^，,。？！?\n]{1,20}?(?:条件下|环境中|时|下)(?:会|出现|发生)?/gu, '$1');
  for (const clause of plain.split(/[？?！!，,。；;：:\n]/u)) {
    const subject = clause.trim().replace(/^(?:(?:请问(?:一下)?|麻烦(?:你)?|请你|请(?=帮我|分析|解释)|帮我|看一下|看看|分析(?:一下)?|解释(?:一下)?|我想(?:了解|知道)|为什么|为何|怎么|怎样|如何|走(?=\S+线)|关于)\s*)+/u, '')
      .replace(/^.*?(?:有哪些|有什么)/u, '')
      .split(/(?:怎么|怎样|如何|要多久|需要多久|为什么|是否|能否|可不可以|能不能|哪种|是什么|\s(?:after|before|when|while)\s)/iu, 1)[0]
      .replace(/(?:呢|吗|应该|可以|到底)$/u, '');
    let title = '';
    for (const word of words.segment(subject)) {
      const token = word.segment;
      if (!word.isWordLike || filler.test(token) || /^\d+(?:px|rem|ms|gb|mb|kb)?$/iu.test(token)) continue;
      const spaced = title && /[a-z0-9]$/iu.test(title) && /^\s/u.test(subject.slice(Math.max(0, word.index - 1), word.index));
      const next = title + (spaced ? ' ' : '') + token;
      if (excerpt(next) !== next) { if (title) break; else continue; }
      title = next;
    }
    if (title) return title;
  }
  return '节点';
}

export function DagCardSummary({ question, summary, onSummaryChange }: CardSummaryProps & { question: string }) {
  const automatic = useMemo(() => nodeName(question), [question]);
  const override = excerpt(summary?.trim() ?? '');
  const displayed = override || automatic;
  const [value, setValue] = useState<string | null>(null);
  const composing = useRef(false);
  const finished = useRef(false);
  function finish(text: string, save: boolean) {
    if (finished.current) return;
    finished.current = true;
    composing.current = false;
    const next = excerpt(text.trim());
    if (save && next !== displayed && (next || override)) onSummaryChange?.(next);
    setValue(null);
  }
  return (
    <div className="dag-card-name"
      onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      {value === null || !onSummaryChange ? (
        <button data-dag-summary type="button" disabled={!onSummaryChange}
          className="block max-w-full truncate focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          aria-label={`节点名：${displayed}`} title={onSummaryChange ? '单击编辑节点名（最多 10 个字）' : displayed}
          onClick={() => { finished.current = false; setValue(displayed); }}>
          {displayed}
        </button>
      ) : (
        <Input autoFocus data-dag-summary-input aria-label="编辑节点名" size="sm" value={value}
          inputClassName="h-6 w-[12em] max-w-full rounded-sm bg-popover px-1 text-13"
          onFocus={e => e.target.select()}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={e => { composing.current = false; setValue(excerpt(e.currentTarget.value)); }}
          onChange={text => setValue(composing.current ? text : excerpt(text))}
          onBlur={e => finish(e.currentTarget.value, true)}
          onKeyDown={e => {
            e.stopPropagation();
            if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key !== 'Enter' && e.key !== 'Escape') return;
            e.preventDefault();
            finish(e.currentTarget.value, e.key === 'Enter');
          }} />
      )}
    </div>
  );
}
