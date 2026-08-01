import { describe, expect, it } from 'vitest';

import { redactAgentProxyUrlForLog } from '../agentProxyConfig';

describe('redactAgentProxyUrlForLog', () => {
  it('removes userinfo and URL path/query/fragment from diagnostics', () => {
    const diagnostic = redactAgentProxyUrlForLog(
      'http://sensitive-user:sensitive-password@proxy.example:8080/path?token=secret#fragment',
    );

    expect(diagnostic).toBe('http://proxy.example:8080');
    expect(diagnostic).not.toContain('sensitive');
    expect(diagnostic).not.toContain('token');
    expect(diagnostic).not.toContain('secret');
  });

  it('keeps only the scheme and endpoint for supported proxy URLs', () => {
    expect(redactAgentProxyUrlForLog('socks5h://proxy.example:1080')).toBe(
      'socks5h://proxy.example:1080',
    );
    expect(redactAgentProxyUrlForLog('https://[2001:db8::1]:8443/a')).toBe(
      'https://[2001:db8::1]:8443',
    );
    expect(redactAgentProxyUrlForLog('https://proxy.example:443/path')).toBe(
      'https://proxy.example',
    );
  });

  it('uses a fixed placeholder for malformed or unsupported values', () => {
    expect(redactAgentProxyUrlForLog('')).toBe('[redacted]');
    expect(redactAgentProxyUrlForLog('http://proxy.example/\nsecret')).toBe('[redacted]');
    expect(redactAgentProxyUrlForLog('not a URL user:password')).toBe('[redacted]');
    expect(redactAgentProxyUrlForLog('ftp://user:password@example.com/file')).toBe('[redacted]');
    expect(redactAgentProxyUrlForLog({ password: 'secret' })).toBe('[redacted]');
  });

  it('does not decode percent-encoded path credentials into diagnostics', () => {
    const diagnostic = redactAgentProxyUrlForLog(
      'http://proxy.example:8080/%75ser:%70assword?token=%73ecret',
    );

    expect(diagnostic).toBe('http://proxy.example:8080');
    expect(diagnostic).not.toMatch(/user|password|token|secret/i);
  });
});
