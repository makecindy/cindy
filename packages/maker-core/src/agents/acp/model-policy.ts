/** Models explicitly admitted on the official Google subscription transport.
 * Discovery still requires the pinned CLI to offer each model for this account.
 * These are upstream model IDs, never Anthropic/OpenAI API provider routes.
 */
const partnerModels = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'gpt-oss-120b-medium',
]);

export function isAntigravitySubscriptionModel(id: string): boolean {
  return /^gemini(?:[- /]|$)/i.test(id) || partnerModels.has(id);
}
