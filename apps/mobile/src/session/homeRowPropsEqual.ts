import { dataPropsEqual } from '@/utils/valueEquality';

/** Resident rows can move between home controllers without unmounting. Data
 * equality must not retain callbacks or mutable state from the previous owner. */
export function homeRowPropsEqual(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): boolean {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const a = previous[key];
    const b = next[key];
    if ((typeof a === 'function' || typeof b === 'function'
      || key === 'swipe' || key === 'registry' || key === 'projectHeaderRefs' || key === 'homeScrollY')
      && !Object.is(a, b)) return false;
  }
  return dataPropsEqual(previous, next);
}
