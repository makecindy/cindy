import { TEAMMATE_CONTROL_GUIDANCE } from '@cindy/mcps';
import { buildTeammateGuide as build } from '@cindy/companion-core/guide';
export { TEAMMATE_GUIDE_NAME, TEAMMATE_GUIDE_DESCRIPTION } from '@cindy/companion-core/guide';
export function buildTeammateGuide(options: Parameters<typeof build>[0] = {}): string { return build({ ...options, ownSkillsEnabled: options.helperAvailable !== false && options.ownSkillsEnabled !== false }, TEAMMATE_CONTROL_GUIDANCE); }
