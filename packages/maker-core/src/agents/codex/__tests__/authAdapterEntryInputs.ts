/**
 * What the Codex agent passes to its auth adapter (getState / getAuthEnv), as `providerId | mode`
 * ('-' for absent), on the paths real tasks and controls take: a session for every kind of source,
 * live model refresh as the hosts call it, account rate limits, and credential-free Skill
 * discovery. An independent Codex account appears as ACCOUNT_PROVIDER_ID.
 *
 * Checked against the real agent by index.test.ts ("the auth adapter sees only these inputs");
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
