import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { teammateFolderName, teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';
import { useBotProfiles } from '@/features/bots/botStore';
import { useProjectAliases } from '@/features/cc-agent/hooks/useProjectAliases';
import { normalizeProjectKey } from '../../../../shared/projectKeys';

function lastPathSegment(input: string): string {
  return input.split(/[\\/]/).filter(Boolean).pop() ?? input;
}

/**
 * How an automation names its project, like the sidebar: a teammate's project by the teammate,
 * any other project by its name, the folder only as a fallback. Every teammate project folder is
 * called `workspace`, so the folder alone cannot tell them apart (2026-11-10).
 */
export function useProjectLabel(): (workingDir: string) => string {
  const { t } = useTranslation();
  const bots = useBotProfiles();
  const { aliases } = useProjectAliases();
  return useCallback((workingDir: string) => {
    const folder = teammateFolderOfProjectPath(workingDir);
    const bot = folder ? bots.find((candidate) => teammateFolderName(candidate.id) === folder) : undefined;
    if (bot) return t('scheduler.list.section.teammate', { name: bot.name });
    const key = normalizeProjectKey(`local:${workingDir}`);
    return (key && aliases.get(key)) || lastPathSegment(workingDir);
  }, [aliases, bots, t]);
}
