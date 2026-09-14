import { previewAgentEndpoint } from './sshAuthentication.js';

interface SensitiveSshConfig {
  identityFile?: string;
  sshAuthentication?: {
    identityAgent?: string;
    configuredIdentityFiles?: string[];
  };
}

interface Replacement {
  value: string;
  replacement: '<identity-agent>' | '<identity-file>';
}

/**
 * Remove local credential paths immediately before text crosses a trusted
 * boundary. Resolved Agent endpoints are deliberately computed on demand and
 * never stored on HostConfig or HostSnapshot.
 */
export function redactSshSensitiveText(
  config: SensitiveSshConfig,
  text: string,
): string {
  const replacements = credentialReplacements(config);
  let redacted = text;
  for (const { value, replacement } of replacements) {
    redacted = redacted.split(value).join(replacement);
  }
  return redacted;
}

function credentialReplacements(
  config: SensitiveSshConfig,
): Replacement[] {
  const byValue = new Map<string, Replacement['replacement']>();
  const add = (value: string | undefined, replacement: Replacement['replacement']): void => {
    if (!value || value.trim() === '') return;
    // OpenSSH's lowercase sentinel is behavior, not a sensitive endpoint, and
    // replacing the ordinary word "none" would corrupt unrelated diagnostics.
    if (replacement === '<identity-agent>' && value === 'none') return;
    const previous = byValue.get(value);
    if (previous === undefined || replacement === '<identity-agent>') {
      byValue.set(value, replacement);
    }
  };

  add(config.identityFile, '<identity-file>');
  for (const value of config.sshAuthentication?.configuredIdentityFiles ?? []) {
    add(value, '<identity-file>');
  }

  const identityAgent = config.sshAuthentication?.identityAgent;
  add(identityAgent, '<identity-agent>');
  add(previewAgentEndpoint(identityAgent).endpoint, '<identity-agent>');

  return Array.from(byValue, ([value, replacement]) => ({ value, replacement }))
    .sort((left, right) => {
      const byLength = right.value.length - left.value.length;
      if (byLength !== 0) return byLength;
      return Number(right.replacement === '<identity-agent>')
        - Number(left.replacement === '<identity-agent>');
    });
}
