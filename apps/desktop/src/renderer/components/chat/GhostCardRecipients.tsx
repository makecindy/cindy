import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fitGhostCardRecipients,
  ghostCardRecipients,
  GHOST_CARD_FORM_MAX_VALUE,
  type GhostCardFormField,
} from '@cindy/maker-shared/ghost-card-form';
import { Textarea } from '@/components/ui/input';

const chipClass =
  'inline-block max-w-40 shrink-0 truncate rounded-full bg-muted px-2 py-1 text-12 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
const moreClass =
  'inline-block shrink-0 rounded-full px-1 py-1 text-12 text-muted-foreground focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

/** Measure real names and card width; expanding replaces the summary. */
export function GhostCardRecipients({
  fields,
  disabled,
  readOnly = false,
  onChange,
}: {
  fields: GhostCardFormField[];
  disabled: boolean;
  readOnly?: boolean;
  onChange: (name: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [counts, setCounts] = useState<number[]>([]);
  const [needsExpansion, setNeedsExpansion] = useState(false);
  const canExpand = !readOnly || needsExpansion;
  const root = useRef<HTMLDivElement>(null),
    measure = useRef<HTMLDivElement>(null);
  const summaryFields = fields.filter((field) => field.name !== 'bcc' && !field.collapsed);
  const entries = summaryFields.map((field) => ghostCardRecipients(field.value));
  const signature = JSON.stringify(fields);
  useLayoutEffect(() => {
    const node = root.current,
      probe = measure.current;
    if (!node) return;
    if (expanded) {
      const fit = () =>
        node.querySelectorAll('textarea').forEach((input) => {
          input.style.height = 'auto';
          input.style.height = `${input.scrollHeight + 2}px`;
        });
      fit();
      let width = node.clientWidth;
      const observer = new ResizeObserver(() => {
        if (node.clientWidth !== width) {
          width = node.clientWidth;
          fit();
        }
      });
      observer.observe(node);
      return () => observer.disconnect();
    }
    if (!probe) return;
    const layout = () => {
      const width = (key: string) =>
        probe.querySelector<HTMLElement>(`[data-measure="${key}"]`)?.getBoundingClientRect()
          .width ?? 0;
      const groups = entries.map((items, i) => ({
        label: width(`label-${i}`),
        chips: items.map((_, j) => width(`chip-${i}-${j}`)),
        more: Array.from({ length: items.length + 1 }, (_, j) => width(`more-${i}-${j}`)),
      }));
      const available = node.clientWidth - summaryFields.length * 12;
      const fullCounts = fitGhostCardRecipients(available, groups);
      const hidden =
        fields.some((f) => (f.name === 'bcc' || f.collapsed) && f.value.trim()) ||
        entries.some(
          (items, i) =>
            fullCounts[i] < items.length ||
            items.some((entry, j) => {
              const chip = probe.querySelector<HTMLElement>(`[data-measure="chip-${i}-${j}"]`);
              return (
                entry.label !== entry.address || (!!chip && chip.scrollWidth > chip.clientWidth)
              );
            }),
        );
      const next =
        !readOnly || hidden
          ? fitGhostCardRecipients(available - width('toggle'), groups)
          : fullCounts;
      setNeedsExpansion(hidden);
      setCounts((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(node);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [signature, expanded, readOnly, t]);
  const expand = t('chat.ghostCall.expandFields'),
    collapse = t('chat.ghostCall.collapseFields');
  const more = (count: number) => (count ? `+${count}` : '+');
  return (
    <div ref={root} className="relative w-full min-w-0 overflow-hidden border-b border-border py-1">
      {expanded ? (
        fields.map((field, i) => (
          <div key={field.name} className="flex items-start gap-2 py-0.5">
            <span aria-hidden className="shrink-0 pt-0.5 text-12 text-muted-foreground">
              {field.label}
            </span>
            <Textarea
              disabled={disabled}
              aria-label={field.label}
              value={field.value}
              rows={1}
              maxLength={GHOST_CARD_FORM_MAX_VALUE}
              className="min-h-0 flex-1 resize-none overflow-hidden border-transparent bg-transparent px-1 py-0.5 leading-5 shadow-none"
              onChange={(value) => onChange(field.name, value)}
            />
            {i === 0 && (
              <button
                type="button"
                aria-expanded="true"
                className={moreClass}
                onClick={() => setExpanded(false)}
              >
                {collapse}
              </button>
            )}
          </div>
        ))
      ) : (
        <>
          <div className="flex min-h-8 items-center gap-3 overflow-hidden">
            {summaryFields.map((field, i) => {
              const count = counts[i] ?? 0,
                remaining = entries[i].length - count;
              return (
                <div key={field.name} className="flex shrink-0 items-center gap-1">
                  <span className="text-12 text-muted-foreground">{field.label}</span>
                  {entries[i].slice(0, count).map((entry, j) =>
                    canExpand ? (
                      <button
                        key={j}
                        type="button"
                        className={chipClass}
                        title={entry.address}
                        aria-label={`${field.label}: ${entry.address}`}
                        onClick={() => setExpanded(true)}
                      >
                        {entry.label}
                      </button>
                    ) : (
                      <span key={j} className={chipClass} title={entry.address}>
                        {entry.label}
                      </span>
                    ),
                  )}
                  {(remaining > 0 || !entries[i].length) && (
                    <button
                      type="button"
                      className={moreClass}
                      aria-label={`${field.label}: ${expand} (${entries[i].length})`}
                      onClick={() => setExpanded(true)}
                    >
                      {more(remaining)}
                    </button>
                  )}
                </div>
              );
            })}
            {canExpand && (
              <button
                type="button"
                aria-expanded="false"
                className={`${moreClass} ml-auto`}
                onClick={() => setExpanded(true)}
              >
                {expand}
              </button>
            )}
          </div>
          <div
            ref={measure}
            aria-hidden
            className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-0"
          >
            <span data-measure="toggle" className={moreClass}>
              {expand}
            </span>
            {summaryFields.map((field, i) => (
              <div key={field.name} className="flex w-max items-center">
                <span data-measure={`label-${i}`} className="text-12">
                  {field.label}
                </span>
                {entries[i].map((entry, j) => (
                  <span key={j} data-measure={`chip-${i}-${j}`} className={chipClass}>
                    {entry.label}
                  </span>
                ))}
                {Array.from({ length: entries[i].length + 1 }, (_, j) => (
                  <span key={`more-${j}`} data-measure={`more-${i}-${j}`} className={moreClass}>
                    {more(j)}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
