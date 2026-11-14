/**
 * What the Codex agent passes to its auth adapter (getState / getAuthEnv), as `providerId | mode`
 * ('-' for absent), on the paths real tasks and controls take: a session for every kind of source,
 * live model refresh as the hosts call it, account rate limits, and credential-free Skill
 * discovery. An independent Codex account appears as ACCOUNT_PROVIDER_ID.
 *
 * Checked against the real agent by index.test.ts ("the auth adapter sees only these inputs"), path by path;
 * the Host and desktop adapter comparison (hostCodexAuthAdapterParity.test.ts) marks every other
 * input as unreachable on these paths.
 */
export const ACCOUNT_PROVIDER_ID = 'codex-account-fixture';

export const CODEX_AUTH_ADAPTER_ENTRY_INPUTS: readonly string[] = [
  '- | -',
  '- | gateway-key',
  '- | oauth-bearer',
  '- | provider-oauth',
  `${ACCOUNT_PROVIDER_ID} | oauth-bearer`,
];

/** The same inputs by path, each path on a fresh agent so none reuses another's host. */
export const CODEX_AUTH_ADAPTER_INPUTS_BY_PATH: Readonly<Record<string, readonly string[]>> = {
  'session (none)': ['- | -'],
  'session xd': ['- | -', '- | gateway-key'],
  'session cindy': ['- | provider-oauth'],
  'session openai': ['- | oauth-bearer'],
  'session xai': ['- | provider-oauth'],
  'session cprov-custom': ['- | provider-oauth'],
  'session account': [`${ACCOUNT_PROVIDER_ID} | oauth-bearer`],
  'refresh after login': ['- | oauth-bearer'],
  'refresh for an account': [`${ACCOUNT_PROVIDER_ID} | oauth-bearer`],
  'refresh for API models': ['- | provider-oauth'],
  'rate limits': ['- | oauth-bearer'],
  'rate limits for an account': [`${ACCOUNT_PROVIDER_ID} | oauth-bearer`],
  'skill discovery': ['- | -'],
};
