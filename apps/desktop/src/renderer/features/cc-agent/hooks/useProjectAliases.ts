import { useCallback, useEffect, useMemo, useState } from 'react';

import { createLogger } from '@/lib/logger';
import type { ProjectAlias } from '../../../../shared/projectAliases';
import { projectKeyComparisonKey } from '../../../../shared/projectKeys';
import { listProjectAliases, onProjectAliasesChanged, setProjectAlias } from '@/lib/projectAliasService';

const log = createLogger('useProjectAliases');

function toAliasMap(rows: readonly ProjectAlias[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!row.projectKey || !row.alias) continue;
    map.set(row.projectKey, row.alias);
  }
  return map;
}

export function useProjectAliases(): {
  aliases: ReadonlyMap<string, string>;
  updateAlias: (projectKey: string, alias: string) => Promise<void>;
} {
  const [rows, setRows] = useState<ProjectAlias[]>([]);

  const refresh = useCallback(async () => {
    try {
      setRows(await listProjectAliases());
    } catch (err) {
      log.warn('failed to load project aliases', err);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onProjectAliasesChanged(() => {
      void refresh();
    });
  }, [refresh]);

  const aliases = useMemo(() => toAliasMap(rows), [rows]);

  const updateAlias = useCallback(async (projectKey: string, alias: string) => {
    const nextAlias = alias.trim();
    const previousRows = rows;
    const localPlatform = window.electronAPI.platform;
    const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
    setRows((prev) => {
      const remaining = prev.filter(
        (row) => projectKeyComparisonKey(row.projectKey, localPlatform) !== comparisonKey,
      );
      if (!nextAlias) return remaining;
      return [
        { projectKey, alias: nextAlias, updatedAt: new Date().toISOString() },
        ...remaining,
      ];
    });

    try {
      await setProjectAlias(projectKey, nextAlias);
    } catch (err) {
      setRows(previousRows);
      throw err;
    }
  }, [rows]);

  return { aliases, updateAlias };
}
