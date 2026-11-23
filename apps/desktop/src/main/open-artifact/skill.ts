import { localSkill } from '@open-artifact/harness-kit';
import { renderedSkillFile } from '@open-artifact/protocol';

/** The built-in system Skill folder name; it is also the slash command the user types (`/artifacts`). */
export const ARTIFACTS_SKILL_COMMAND = 'artifacts';

/**
 * What the committed `resources/system-skills/artifacts/SKILL.md` is rendered from. Cindy exposes the three tools
 * natively (`cindy_artifacts` MCP server) and shows pages itself in the right sidebar, so the Skill tells the agent
 * that the app opens pages (`opens: 'host'`) instead of asking it to print links for the user to click.
 */
export const ARTIFACTS_SKILL_PARAMS = {
  command: ARTIFACTS_SKILL_COMMAND,
  agentName: 'Cindy',
  tools: 'native',
  opens: 'host',
} as const satisfies Parameters<typeof localSkill>[0];

/** The exact bytes the pinned kit renders; `__tests__/openArtifact.test.ts` fails when the committed file drifts. */
export function renderArtifactsSkill(): string {
  return renderedSkillFile(localSkill(ARTIFACTS_SKILL_PARAMS));
}
