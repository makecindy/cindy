import { afterEach, describe, expect, it } from 'vitest';

import { previewAgentEndpoint } from '../sshAuthentication.js';
import { redactAuthFailureDetail, redactSshSensitiveText } from '../sshRedaction.js';
import type { HostConfig } from '../types.js';

const originalAgent = process.env.SSH_AUTH_SOCK;

afterEach(() => {
  if (originalAgent === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = originalAgent;
});

function config(identityAgent?: string): HostConfig {
  return {
    id: 'lab',
    hostname: 'lab',
    port: 22,
    user: 'developer',
    authMethod: 'agent',
    identityFile: '/private/tmp/agent/identity',
    sshAuthentication: {
      identitiesOnly: false,
      ...(identityAgent !== undefined ? { identityAgent } : {}),
      configuredIdentityFiles: ['/private/tmp/agent/identity.pub'],
      identityFileDirectiveSeen: true,
      identityFileNoneSeen: false,
    },
    source: 'ssh-config',
    managedByCindy: false,
  };
}

describe('redactSshSensitiveText', () => {
  it('redacts IdentityAgent literals, expanded endpoints, and overlapping identity paths', () => {
    process.env.SSH_AUTH_SOCK = '/private/tmp/com.apple.launchd.example/Listeners';
    const text = [
      'SSH_AUTH_SOCK',
      '/private/tmp/com.apple.launchd.example/Listeners',
      '/private/tmp/agent/identity.pub',
      '/private/tmp/agent/identity',
    ].join(' ');

    const redacted = redactSshSensitiveText(config('SSH_AUTH_SOCK'), text);
    expect(redacted).toBe(
      '<identity-agent> <identity-agent> <identity-file> <identity-file>',
    );
  });

  it('redacts explicit Windows named pipes without depending on process.platform', () => {
    const pipe = String.raw`\\.\pipe\openssh-ssh-agent`;
    expect(redactSshSensitiveText(config(pipe), `connect ${pipe} failed`))
      .toBe('connect <identity-agent> failed');
  });

  it('uses the default endpoint when IdentityAgent is absent', () => {
    process.env.SSH_AUTH_SOCK = '/private/tmp/default-agent.sock';
    const endpoint = previewAgentEndpoint(undefined).endpoint;
    expect(endpoint).toBeTruthy();
    expect(redactSshSensitiveText(config(), `connect ${endpoint} failed`))
      .toBe('connect <identity-agent> failed');
  });

  it('does not replace the none sentinel or an unset variable with ordinary text', () => {
    delete process.env.CINDY_TEST_UNSET_AGENT;
    expect(redactSshSensitiveText(config('none'), 'none is an ordinary word'))
      .toBe('none is an ordinary word');
    expect(redactSshSensitiveText(
      config('$CINDY_TEST_UNSET_AGENT'),
      'endpoint $CINDY_TEST_UNSET_AGENT unavailable',
    )).toBe('endpoint <identity-agent> unavailable');
    expect(redactSshSensitiveText(config('$CINDY_TEST_UNSET_AGENT'), 'ordinary text'))
      .toBe('ordinary text');
    expect(redactSshSensitiveText(config(''), 'ordinary text'))
      .toBe('ordinary text');
  });
});

describe('redactAuthFailureDetail (#4201)', () => {
  it('redacts every string field the same way as the lastError text, leaving kind/user/host intact', () => {
    const cfg = config();
    const detail = redactAuthFailureDetail(cfg, {
      kind: 'key-rejected',
      user: 'developer',
      hostname: 'lab',
      identities: ['/private/tmp/agent/identity', 'id_other'],
      command: 'ssh-copy-id -i /private/tmp/agent/identity.pub developer@lab',
      cause: 'failed reading /private/tmp/agent/identity',
    });
    expect(detail).toEqual({
      kind: 'key-rejected',
      user: 'developer',
      hostname: 'lab',
      identities: ['<identity-file>', 'id_other'],
      command: 'ssh-copy-id -i <identity-file> developer@lab',
      cause: 'failed reading <identity-file>',
    });
  });

  it('does not invent optional fields', () => {
    const detail = redactAuthFailureDetail(config(), {
      kind: 'agent-pinned',
      user: 'developer',
      hostname: 'lab',
      identities: [],
    });
    expect(detail).not.toHaveProperty('command');
    expect(detail).not.toHaveProperty('cause');
  });
});
