import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import type { JSONContent } from '@tiptap/core';
import { leadingSlashInvocation } from '@cindy/maker-shared';
import type { InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import { filterGhostsForWorkdir } from '@/cindy-brain/ghostWorkdirFilter';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import {
  getDraft as getComposerDraft,
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
  tiptapDocHasContent,
} from '@/lib/composerDraftStore';
import type { PluginSkillSetupPaletteEntry } from '@/lib/slashCommands';
import { toast } from '@/lib/toast';
import { readPluginRecommendationSnapshot } from './pluginHomeSuggestions';
import {
  getPendingPluginSuggestion,
  startPendingPluginSuggestion,
  takePendingPluginSuggestion,
  type PluginSuggestionRequest,
} from './pendingPluginSuggestion';

/**
 * Plugin Skills the `/` palette offers before their plugin is usable. Hardcoded like
 * the Gmail home-suggestion fallback: the palette cannot query the market offline,
 * and only first-party Skills that used to ship built-in belong here (`/pr` moved
 * from Cindy's bundle into the cindy-github plugin, which is not installed by default).
 */
export type PluginSkillSetupState = 'install' | 'enable';

export const PLUGIN_SKILL_SETUPS: readonly {
  ghostId: string;
  skillName: string;
  descriptionKeys: Record<PluginSkillSetupState, string>;
}[] = [
  {
    ghostId: 'cindy-github',
    skillName: 'pr',
    descriptionKeys: {
      install: 'commandPalette.pluginSkills.pr.install',
      enable: 'commandPalette.pluginSkills.pr.enable',
    },
  },
];

const SETUP_META_KEYS: Record<PluginSkillSetupState, string> = {
  install: 'commandPalette.pluginSkillSetup.install',
  enable: 'commandPalette.pluginSkillSetup.enable',
};

/** What each Skill's plugin still needs here; omitted when it is already usable. */
export function pluginSkillSetupStates(
  installed: InstalledGhost[],
  workingDir: string | null,
): ((typeof PLUGIN_SKILL_SETUPS)[number] & { state: PluginSkillSetupState })[] {
  const usable = filterGhostsForWorkdir(installed, workingDir).filter((g) => g.enabled);
  return PLUGIN_SKILL_SETUPS.flatMap((setup) => {
    const ghost = installed.find((g) => installedGhostStoragePart(g) === setup.ghostId);
    if (ghost && usable.includes(ghost)) return [];
    return [{ ...setup, state: ghost ? 'enable' : 'install' } as const];
  });
}

/**
 * Where to make `pluginId` usable: its installed page, or its single market listing.
 * null = no single trusted source (do not silently choose between publishers).
 */
export async function pluginSetupRoute(
  ghost: InstalledGhost | undefined,
  pluginId: string,
): Promise<string | null> {
  if (ghost) return `/plugins?ghost=${encodeURIComponent(installedGhostStoragePart(ghost))}`;
  const market = await window.electronAPI.pluginMarket.lookup([pluginId]);
  const matches = market.items.filter(
    (item) => item.ghostId === pluginId && item.installState !== 'conflict',
  );
  return matches.length === 1 ? `/plugins?market=${encodeURIComponent(matches[0].pluginId)}` : null;
}

/** Put `/<skill> ` at the start of a composer doc, keeping what the user had written. */
export function prependSlashSkill(
  doc: JSONContent | null | undefined,
  skillName: string,
): JSONContent {
  const token = `/${skillName} `;
  if (!doc || !tiptapDocHasContent(doc)) return plainTextToTiptapDoc(token);
  const blocks = doc.content ?? [];
  const [first, ...rest] = blocks;
  if (first?.type === 'paragraph') {
    const inline = first.content ?? [];
    const lead = inline[0];
    if (
      lead?.type === 'text' &&
      leadingSlashInvocation(lead.text ?? '')?.name.toLowerCase() === skillName.toLowerCase()
    )
      return doc;
    return { ...doc, content: [{ ...first, content: [{ type: 'text', text: token }, ...inline] }, ...rest] };
  }
  return { ...doc, content: [{ type: 'paragraph', content: [{ type: 'text', text: token }] }, ...blocks] };
}

/** Non-silent write: a mounted ChatInput re-reads the draft, otherwise it restores on mount. */
export function fillSlashSkillIntoDraft(draftKey: string, skillName: string): void {
  const existing = getComposerDraft(draftKey);
  saveComposerDraft(draftKey, {
    ...existing,
    text: prependSlashSkill(existing?.text, skillName),
    attachments: existing?.attachments ?? [],
  });
}

/**
 * `/` palette setup rows for one composer, plus the return leg: after install or
 * enable, GhostPluginPage navigates back to `returnTo` with the nonce, and the
 * composer whose owner/target matches fills `/<skill> ` without sending.
 * Callers pass enabled=false where the Gmail flow is excluded (SSH, device link).
 */
export function usePluginSkillSetup(params: {
  enabled: boolean;
  ownerId: string | null;
  workingDir: string | null;
  /** Identity of this composer's execution target; the resume must match it. */
  targetKey: string;
  draftKey: string;
  /** Refuse to fill while the composer is sending or otherwise locked. */
  canFill?: () => boolean;
}): { entries: readonly PluginSkillSetupPaletteEntry[]; onSelect: (skillName: string) => void } | undefined {
  const { enabled, ownerId, workingDir, targetKey, draftKey, canFill } = params;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const installed = useInstalledGhosts(enabled);
  const active = enabled && !!ownerId;
  const entries = useMemo(
    () =>
      active
        ? pluginSkillSetupStates(installed, workingDir).map(
            ({ skillName, descriptionKeys, state }) => ({
              skillName,
              description: t(descriptionKeys[state]),
              meta: t(SETUP_META_KEYS[state]),
              replacesInstalled: state === 'enable',
            }),
          )
        : [],
    [active, installed, t, workingDir],
  );

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useRef({ ownerId, targetKey });
  current.current = { ownerId, targetKey };
  const flight = useRef(false);
  const returnTo = `${location.pathname}${location.search}`;

  const onSelect = useCallback(
    async (skillName: string) => {
      const setup = PLUGIN_SKILL_SETUPS.find((x) => x.skillName === skillName);
      if (!active || !ownerId || !setup || flight.current) return;
      flight.current = true;
      const stillCurrent = () =>
        mounted.current &&
        current.current.ownerId === ownerId &&
        current.current.targetKey === targetKey &&
        readPluginRecommendationSnapshot().ownerId === ownerId;
      try {
        if (!stillCurrent()) return;
        const ghosts = window.electronAPI.ghosts.listSync().ghosts;
        const ghost = ghosts.find((g) => installedGhostStoragePart(g) === setup.ghostId);
        if (pluginSkillSetupStates(ghosts, workingDir).every((x) => x.skillName !== skillName)) {
          // Became usable after the palette rendered: behave like picking the real Skill.
          if (canFill?.() !== false) fillSlashSkillIntoDraft(draftKey, skillName);
          return;
        }
        const route = await pluginSetupRoute(ghost, setup.ghostId);
        if (!stillCurrent()) return;
        if (!route) {
          toast.info(t('newChat.pluginSuggestions.unavailable'));
          return;
        }
        const request: PluginSuggestionRequest = {
          suggestion: {
            id: `plugin-skill:${setup.ghostId}:${skillName}`,
            category: 'development',
            label: `/${skillName}`,
            prompt: `/${skillName} `,
            pluginId: setup.ghostId,
            needsInstall: !ghost,
            ownerId,
          },
          ownerId,
          targetKey,
          workingDir,
          returnTo,
          skillName,
        };
        const nonce = startPendingPluginSuggestion(request);
        navigate(`${route}&recommendation=${encodeURIComponent(nonce)}`);
      } catch {
        if (mounted.current) toast.error(t('newChat.pluginSuggestions.unavailable'));
      } finally {
        flight.current = false;
      }
    },
    [active, canFill, draftKey, navigate, ownerId, returnTo, t, targetKey, workingDir],
  );

  useEffect(() => {
    const nonce = (location.state as { pluginSuggestionNonce?: unknown } | null)
      ?.pluginSuggestionNonce;
    if (typeof nonce !== 'string') return;
    const pending = getPendingPluginSuggestion();
    // Only the composer that asked resumes. Home suggestions and other mounted
    // views of the same route (rails, split panes) leave the request alone.
    if (!pending?.skillName || pending.nonce !== nonce || pending.targetKey !== targetKey) return;
    const request = takePendingPluginSuggestion(nonce, ownerId, targetKey);
    if (!request?.skillName || !active || canFill?.() === false) return;
    fillSlashSkillIntoDraft(draftKey, request.skillName);
  }, [active, canFill, draftKey, location.state, ownerId, targetKey]);

  return useMemo(
    () =>
      entries.length > 0
        ? { entries, onSelect: (skillName: string) => void onSelect(skillName) }
        : undefined,
    [entries, onSelect],
  );
}
