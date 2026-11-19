import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const HEADING = '[data-settings-section-heading]';

function containsSectionHeading(node: Node) {
  return node instanceof Element && (node.matches(HEADING) || node.querySelector(HEADING) !== null);
}

export function SettingsPageOutline({ contentRef, scrollRef }: {
  contentRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const [sections, setSections] = useState<{ heading: HTMLElement; label: string }[]>([]);
  const destination = useRef<HTMLElement>(null);

  useEffect(() => {
    const page = contentRef.current;
    if (!page) return;
    const collect = () => {
      const next = Array.from(page.querySelectorAll<HTMLElement>(HEADING))
        .filter((heading) => {
          const closed = heading.closest('details:not([open])');
          const summary = heading.tagName === 'SUMMARY' && heading.parentElement === closed;
          return (!closed || summary) && heading.getClientRects().length > 0;
        })
        .map((heading) => ({ heading, label: heading.textContent?.trim() ?? '' }))
        .filter(({ label }) => label.length > 0);
      setSections((previous) => previous.length === next.length && previous.every((item, index) =>
        item.heading === next[index].heading && item.label === next[index].label) ? previous : next);
    };
    collect();

    // Lazy children and visibility changes can change the index. Ordinary updates to controls do not.
    const observer = new MutationObserver((records) => {
      if (records.some(({ target, addedNodes, removedNodes, type }) => {
        const element = target instanceof Element ? target : target.parentElement;
        return Boolean(element?.closest(HEADING)) ||
          (type === 'attributes' && containsSectionHeading(target)) ||
          Array.from(addedNodes).some(containsSectionHeading) || Array.from(removedNodes).some(containsSectionHeading);
      })) collect();
    });
    observer.observe(page, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    return () => observer.disconnect();
  }, [contentRef]);

  if (sections.length < 3) return null;

  return (
    <div className="mb-3 flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="secondary" className="gap-2" data-settings-search-action="Open the current page section index">
            <List size={15} aria-hidden />
            {t('settings.contentGroups.jump')}
            <ChevronDown size={14} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[min(55vh,24rem)] overflow-y-auto" onCloseAutoFocus={(event) => {
          const target = destination.current;
          destination.current = null;
          const scroll = scrollRef.current;
          if (!target || !scroll?.contains(target)) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
          scroll.scrollTo({
            top: Math.max(0, target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 12),
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          });
        }}>
          {sections.map(({ heading, label }, index) => (
            <DropdownMenuItem key={`${label}:${index}`} onSelect={() => { destination.current = heading; }}
              data-settings-search-action="Scroll to an existing settings section">
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
