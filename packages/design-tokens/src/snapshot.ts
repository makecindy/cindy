import { readFileSync } from 'node:fs';

import { snapshotPath } from './paths.ts';

export interface SnapshotColor {
  id: string;
  light: string | null;
  dark: string | null;
}

export interface ColorDefaultsSnapshot {
  source: string;
  count: number;
  colors: SnapshotColor[];
}

export function readSnapshot(repoRoot?: string): ColorDefaultsSnapshot {
  return JSON.parse(readFileSync(snapshotPath(repoRoot), 'utf8')) as ColorDefaultsSnapshot;
}

export function snapshotById(
  snapshot: ColorDefaultsSnapshot,
): Map<string, SnapshotColor> {
  return new Map(snapshot.colors.map((entry) => [entry.id, entry]));
}
