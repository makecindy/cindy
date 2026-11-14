import { useLayoutEffect, useMemo, useRef } from 'react';
import { HOME_MAIN_SECTION_KEY, type HomeSection } from './homeSections';
import type { HomeViewSession } from './homeViewSession';
import { type HomeDisplayOrder } from './homeProjectOrder';
export type { HomeDisplayOrder } from './homeProjectOrder';

/** Keep existing rows in place, but always use their newest data. New rows append. */
export function stabilizeHomeSections(sections: HomeSection[], previous: HomeDisplayOrder | null, scope: string): HomeSection[] {
  if (!previous || previous.scope !== scope) return sections;
  const next = sections.map(section => {
    if (section.key !== HOME_MAIN_SECTION_KEY) return section;
    const remaining = new Map(section.data.map(row => [row.key, row]));
    const data = [];
    for (const key of previous.keys) {
      const row = remaining.get(key);
      if (row) { data.push(row); remaining.delete(key); }
    }
    data.push(...remaining.values());
    return data.every((row, index) => row === section.data[index]) ? section : { ...section, data };
  });
  return next.every((section, index) => section === sections[index]) ? sections : next;
}

export function useStableHomeSections(input: {
  sections: HomeSection[];
  scope: string;
  revision: number;
  ready: boolean;
  settled: boolean;
  visible: boolean;
  session: HomeViewSession;
  seed: HomeDisplayOrder | null;
  onCommit: (order: HomeDisplayOrder) => void;
}): HomeSection[] {
  const committed = useRef<{
    session: HomeViewSession; order: HomeDisplayOrder | null; revision: number; visible: boolean;
  } | null>(null);
  const previous = committed.current?.session === input.session ? committed.current : null;
  const returning = previous && !previous.visible && input.visible;
  // A remounted drawer is a new visit too. Only a genuinely cold view session
  // restores the disk seed; the retained order marks that a visit already rendered.
  const reset = previous
    ? previous.revision !== input.revision || returning
    : input.session.has('displayOrder');
  const baseline = reset ? null : previous?.order ?? input.seed;
  const sections = useMemo(() => input.ready
    ? stabilizeHomeSections(input.sections, baseline, input.scope) : [],
  [input.ready, input.sections, baseline, input.scope]);
  useLayoutEffect(() => {
    if (!input.ready) return;
    const keys = sections.find(section => section.key === HOME_MAIN_SECTION_KEY)?.data.map(row => row.key) ?? [];
    // Local cache and identity reads settle independently. An empty projection before
    // the first network result must not erase the restored order.
    if (keys.length === 0 && !input.settled) {
      committed.current = {
        session: input.session,
        order: baseline ?? (reset ? { scope: input.scope, keys: [] } : null),
        revision: input.revision,
        visible: input.visible,
      };
      return;
    }
    const order = previous?.order?.scope === input.scope
      && previous.order.keys.length === keys.length
      && previous.order.keys.every((key, index) => key === keys[index])
      ? previous.order : { scope: input.scope, keys };
    committed.current = { session: input.session, order, revision: input.revision, visible: input.visible };
    if (!input.visible) return;
    const saved = input.session.read<HomeDisplayOrder | null>('displayOrder', null);
    if (saved?.scope === order.scope && saved.keys.length === keys.length
      && saved.keys.every((key, index) => key === keys[index])) return;
    input.session.write('displayOrder', order);
    input.onCommit(order);
  });
  return sections;
}
