import { useLayoutEffect, useMemo, useRef } from 'react';
import { HOME_MAIN_SECTION_KEY, type HomeSection } from './homeSections';
import type { HomeViewSession } from './homeViewSession';
import { type HomeDisplayOrder } from './homeProjectOrder';
export type { HomeDisplayOrder } from './homeProjectOrder';

const isDeviceSection = (section: HomeSection) => section.key.startsWith('device:');
const hasStableRows = (section: HomeSection) => section.key === HOME_MAIN_SECTION_KEY || isDeviceSection(section);
const sectionOrderKey = (section: HomeSection) => 'section:' + section.key;

/** Unknown keys share the last rank so newly arrived siblings keep their candidate order. */
function inDisplayOrder<T>(items: T[], key: (item: T) => string, ranks: ReadonlyMap<string, number>): T[] {
  const rank = (item: T) => ranks.get(key(item)) ?? Number.MAX_SAFE_INTEGER;
  for (let i = 1; i < items.length; i++) {
    if (rank(items[i - 1]) > rank(items[i])) return items.slice().sort((a, b) => rank(a) - rank(b));
  }
  return items;
}

/** Keep existing device sections and their rows in place, always using their latest content. */
export function stabilizeHomeSections(sections: HomeSection[], previous: HomeDisplayOrder | null, scope: string): HomeSection[] {
  if (!previous || previous.scope !== scope) return sections;
  const ranks = new Map(previous.keys.map((key, index) => [key, index]));
  const devices = inDisplayOrder(sections.filter(isDeviceSection), sectionOrderKey, ranks);
  let deviceIndex = 0;
  const next = sections.map(candidate => {
    const section = isDeviceSection(candidate) ? devices[deviceIndex++] : candidate;
    if (!hasStableRows(section)) return section;
    const data = inDisplayOrder(section.data, row => row.key, ranks);
    return data === section.data ? section : { ...section, data };
  });
  return next.every((section, index) => section === sections[index]) ? sections : next;
}

export function useStableHomeSections(input: {
  sections: HomeSection[];
  collapsedGroups?: readonly string[];
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
    const keys = sections.flatMap(section => {
      if (!hasStableRows(section)) return [];
      const rows = section.data.map(row => row.key);
      return isDeviceSection(section) ? [sectionOrderKey(section), ...rows] : rows;
    });
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
  // Folding a header changes visibility only. Commit the full stabilized order above.
  return useMemo(() => {
    if (!input.collapsedGroups?.length) return sections;
    const collapsed = new Set(input.collapsedGroups);
    return sections.map(section => isDeviceSection(section) && collapsed.has(section.key)
      ? { ...section, data: [] } : section);
  }, [sections, input.collapsedGroups]);
}
