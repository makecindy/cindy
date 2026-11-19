import { dbToMakerAgentKind, normalizeDbAgentKind } from '../../shared/agentKindConversion';
import { CINDY_THEME_CREATOR_NAME } from '../../shared/cindyBuiltInSkills';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { getDraft as getWorkspaceDraft, resetDraftWorkspaceTargets } from '@/state/newMakerDraft';
import { draftHasContent, getDraft, plainTextToTiptapDoc, saveDraft } from './composerDraftStore';
import { isSlashCommandUnavailable, loadAllCommands } from './slashCommands';

/** Prepare an editable local task; actual Skill dispatch stays on the normal send path. */
export async function prefillThemeCreatorDraft(
  prompt: string,
): Promise<'prepared' | 'unavailable' | 'context-changed'> {
  const owner = getDataOwnerGeneration();
  const agentKind = dbToMakerAgentKind(normalizeDbAgentKind(getWorkspaceDraft().vendor));
  const commands = await loadAllCommands(agentKind, null, { forceReload: true });
  if (!isDataOwnerGenerationCurrent(owner)) return 'context-changed';
  const creator = commands.find((command) => (
    command.kind === 'agent-skill'
    && command.builtIn === true
    && command.enabled !== false
    && !isSlashCommandUnavailable(command)
    && (command.name === CINDY_THEME_CREATOR_NAME
      || command.name === `cindy:${CINDY_THEME_CREATOR_NAME}`)
  ));
  if (!creator) return 'unavailable';

  const existing = getDraft(NEW_MAKER_DRAFT_KEY);
  if (existing?.builtInSkillIntent?.name === CINDY_THEME_CREATOR_NAME) {
    saveDraft(NEW_MAKER_DRAFT_KEY, { ...existing, focusAtEnd: true });
  } else {
    const text = plainTextToTiptapDoc(`/${creator.name} ${prompt}`);
    // Keep the Skill invocation first, while retaining the user's text, media
    // and browser references. Appending the command would bypass Skill routing.
    saveDraft(NEW_MAKER_DRAFT_KEY, {
      ...existing,
      text: {
        ...text,
        content: [...(text.content ?? []), ...(draftHasContent(existing) ? existing?.text?.content ?? [] : [])],
      },
      attachments: existing?.attachments ?? [],
      builtInSkillIntent: { name: CINDY_THEME_CREATOR_NAME, commandName: creator.name },
      focusAtEnd: true,
    });
  }
  // This entry targets the Cindy on this computer, rather than a stale project,
  // remote machine or extra directory grant from another unfinished task.
  resetDraftWorkspaceTargets();
  return 'prepared';
}
