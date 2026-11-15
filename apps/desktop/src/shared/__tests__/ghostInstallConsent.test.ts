import { describe, expect, it } from 'vitest';

import {
  validateGhostManifest,
  ghostControlPointActive,
  type GhostInstallApproval,
  type GhostManifest,
  type InstalledGhost,
} from '../ghost';
import {
  evaluateGhostInstallConsent,
  ghostInstallConsentKey,
  ghostUpdateNeedsConsent,
} from '../ghostInstallConsent';

function manifest(overrides: Record<string, unknown> = {}): GhostManifest {
  const result = validateGhostManifest({
    schemaVersion: 3,
    minCindyVersion: '0.1.61',
    id: 'weather-chip',
    name: 'Weather',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    network: { hosts: ['api.weather.test'] },
    tools: [{ name: 'forecast', description: 'Read the forecast' }],
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture: ${JSON.stringify(result)}`);
  return result.manifest;
}

function installed(
  base: GhostManifest,
  approval: GhostInstallApproval = { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
): InstalledGhost {
  return { manifest: base, dir: '/userData/cindy-brain/weather-chip', enabled: true, approval };
}

describe('plugin install consent', () => {
  it.each(['browser', 'computer', 'ssh', 'docs', 'discovery'] as const)('requires explicit approval for a newly recognized %s group', group => {
    const next = manifest({ agent: { hostTools: [group] } });
    const old = installed(next);
    expect(evaluateGhostInstallConsent(old, next)).toMatchObject({ kind: 'update',
      added: expect.arrayContaining([expect.objectContaining({ key: `agent:host-tools:${group}` })]) });
    expect(evaluateGhostInstallConsent({ ...old, approvedHostToolGroups: [group] }, next)).toBeNull();
  });

  // §21 unit: a group retained as unknown by an older Host is not an explicit
  // filesystem approval. Existing cases did not cover a newly recognized group.
  it('将亲选目录 files 组单列为扩权，旧声明不补批准', () => {
    const next = manifest({ pick: true, agent: { hostTools: ['files'] } });
    const old = installed(next);
    expect(evaluateGhostInstallConsent(old, next)).toMatchObject({ kind: 'update',
      // The code row also changes from the isolated-page explanation to the
      // approved Host-file explanation; it must remain visible in the consent.
      added: [expect.objectContaining({ key: 'agent:host-tools:files' }), expect.objectContaining({ key: 'code', detailKey: 'codeDetailFiles' })] });
    expect(evaluateGhostInstallConsent({ ...old, approvedHostToolGroups: ['files'] }, next)).toBeNull();
    expect(evaluateGhostInstallConsent(null, next)).toMatchObject({ kind: 'install',
      permissions: expect.arrayContaining([expect.objectContaining({ key: 'agent:host-tools:files' })]) });
  });

  // Static system text is itself reviewed capability content: changing it must
  // trigger update consent, even when the capability name stays the same.
  it('shows static system fragments and asks again when their content changes', () => {
    const fragments = [{ id: 'style', text: 'Original static instructions', order: 10, scope: 'selected-task' }];
    const base = manifest({ systemPrompt: fragments });
    const old = { ...installed(base), approvedControlPoints: ['system-prompt' as const] };
    expect(ghostControlPointActive(old, 'system-prompt')).toBe(true);
    expect(ghostControlPointActive(installed(base), 'system-prompt')).toBe(false);
    const next = manifest({ systemPrompt: [{ ...fragments[0], text: 'Changed static instructions' }] });
    expect(evaluateGhostInstallConsent(old, next)).toMatchObject({ kind: 'update',
      added: [expect.objectContaining({ key: 'system-prompt', detail: expect.stringContaining('Changed static instructions') })],
    });
    expect(evaluateGhostInstallConsent(old, base)).toBeNull();
  });
  it('requires consent when an ordinary plugin switches a saved PAT to shared gh login', () => {
    const secret = { key: 'github_pat', label: 'GitHub', inject: {
      header: 'Authorization', format: 'Bearer {value}', hosts: ['api.github.com'],
    } };
    const base = manifest({ settingsHtml: 'settings.html', network: { hosts: ['api.github.com'], secrets: [secret] } });
    const next = manifest({ settingsHtml: 'settings.html', network: { hosts: ['api.github.com'], secrets: [{ ...secret, source: 'gh-cli' }] } });
    expect(evaluateGhostInstallConsent(installed(base), next)).toMatchObject({ kind: 'update',
      added: expect.arrayContaining([expect.objectContaining({ key: 'network:secret:github_pat' })]),
    });
  });
  // Contract: auto execution is an explicit permission, including declarations
  // preserved by an older Host without a grant. Existing tests covered only tools.
  it('asks for auto execution until it has an explicit approval baseline', () => {
    const next = manifest({ tools: [{ name: 'forecast', description: 'Read the forecast', approval: 'auto' }] });
    const old = installed(next);
    const facts = evaluateGhostInstallConsent(old, next);
    expect(facts).toMatchObject({ kind: 'update', added: [expect.objectContaining({ key: 'tool-auto:forecast' })] });
    expect(evaluateGhostInstallConsent({ ...old, approvedAutoTools: ['forecast'] }, next)).toBeNull();
    expect(evaluateGhostInstallConsent(installed(manifest()), manifest({
      tools: [{ name: 'forecast', description: 'Read the forecast', approval: 'each-call' }],
    }))).toBeNull();
  });
  it('always asks on first install and lists every non-tool permission', () => {
    const facts = evaluateGhostInstallConsent(null, manifest());
    expect(facts).toMatchObject({ kind: 'install', ghostId: 'weather-chip', version: '1.0.0' });
    if (facts?.kind !== 'install') throw new Error('expected install facts');
    expect(facts.permissions.map((item) => item.key)).toContain('network:host:api.weather.test');
    expect(facts.permissions.some((item) => item.kind === 'tool')).toBe(false);
  });

  it('keeps an update silent when permissions are unchanged', () => {
    const current = installed(manifest());
    expect(evaluateGhostInstallConsent(current, manifest({ version: '1.1.0' }))).toBeNull();
    expect(ghostUpdateNeedsConsent(current, manifest({ version: '1.1.0' }))).toBe(false);
  });

  // Unit regression for #6404: an existing tool must not hide new mailbox
  // capabilities from the production install/update consent boundary.
  it('projects mail, reader hosts and read-state writes into install and update consent', () => {
    const base = manifest();
    const compose = manifest({ mail: true });
    const reader = manifest({ mail: true, mailReader: { tool: 'forecast', hosts: ['mail.example.test'] } });
    const full = manifest({ mail: true, mailReader: { tool: 'forecast', hosts: ['mail.example.test'], markRead: true } });
    const additions = (previous: GhostManifest, next: GhostManifest) => {
      const facts = evaluateGhostInstallConsent(installed(previous), next);
      expect(facts?.kind).toBe('update');
      if (facts?.kind !== 'update') throw new Error('expected update facts');
      return facts.added.map(item => item.key);
    };
    expect(additions(base, compose)).toEqual(['mail']);
    expect(additions(compose, reader)).toEqual(['mail-reader:forecast', 'mail-reader:host:mail.example.test']);
    expect(additions(reader, full)).toEqual(['mail-reader:mark-read']);
    expect(additions(reader, manifest({ mail: true,
      tools: [{ name: 'forecast', description: 'Read the forecast' }, { name: 'reader', description: 'Read mail' }],
      mailReader: { tool: 'reader', hosts: ['mail.example.test'] },
    }))).toEqual(['mail-reader:reader']);
    const facts = evaluateGhostInstallConsent(null, full);
    if (facts?.kind !== 'install') throw new Error('expected install facts');
    expect(facts.permissions.map(item => item.key)).toEqual(expect.arrayContaining([
      'mail', 'mail-reader:forecast', 'mail-reader:host:mail.example.test', 'mail-reader:mark-read',
    ]));
    const reordered = manifest({ mail: true, mailReader: { tool: 'forecast', hosts: ['other.example.test', 'mail.example.test'] } });
    expect(additions(reader, reordered)).toEqual(['mail-reader:host:other.example.test']);
    expect(evaluateGhostInstallConsent(installed(reordered), manifest({ mail: true,
      mailReader: { tool: 'forecast', hosts: ['mail.example.test', 'other.example.test', 'mail.example.test'] },
    }))).toBeNull();
    expect(evaluateGhostInstallConsent(installed(full), reader)).toBeNull();
    expect(evaluateGhostInstallConsent(installed(full), base)).toBeNull();
  });

  it('keeps an update silent when it only removes permissions or changes tools', () => {
    const current = installed(manifest({ network: { hosts: ['api.weather.test', 'maps.weather.test'] } }));
    expect(evaluateGhostInstallConsent(current, manifest({ version: '1.1.0' }))).toBeNull();
    const withMoreTools = manifest({
      version: '1.2.0',
      network: { hosts: ['api.weather.test', 'maps.weather.test'] },
      tools: [
        { name: 'forecast', description: 'Read the forecast' },
        { name: 'radar', description: 'Show the radar' },
      ],
    });
    expect(evaluateGhostInstallConsent(current, withMoreTools)).toBeNull();
  });

  it('asks when an update adds a permission and reports the diff', () => {
    const facts = evaluateGhostInstallConsent(
      installed(manifest()),
      manifest({ version: '2.0.0', network: { hosts: ['api.weather.test', 'upload.weather.test'] } }),
    );
    expect(facts).toMatchObject({
      kind: 'update',
      previousVersion: '1.0.0',
      version: '2.0.0',
      builtinOauthClientChanged: false,
    });
    if (facts?.kind !== 'update') throw new Error('expected update facts');
    expect(facts.added.map((item) => item.key)).toEqual(['network:host:upload.weather.test']);
    expect(facts.removed).toEqual([]);
    expect(facts.unchangedCount).toBeGreaterThan(0);
  });

  it('treats an install without an approved baseline as all-new permissions', () => {
    const facts = evaluateGhostInstallConsent(
      installed(manifest(), { state: 'legacy-unapproved' }),
      manifest({ version: '1.1.0' }),
    );
    expect(facts?.kind).toBe('update');
    if (facts?.kind !== 'update') throw new Error('expected update facts');
    expect(facts.added.map((item) => item.key)).toContain('network:host:api.weather.test');
  });

  it('binds the consent key to the exact permission change that was shown', () => {
    const current = installed(manifest());
    const next = manifest({ version: '2.0.0', network: { hosts: ['api.weather.test', 'upload.weather.test'] } });
    const shown = evaluateGhostInstallConsent(current, next)!;
    const digest = 'a'.repeat(64);
    const receiver = 'approved:00000000-0000-4000-8000-000000000001';
    expect(ghostInstallConsentKey(evaluateGhostInstallConsent(current, next)!, digest, receiver)).toBe(
      ghostInstallConsentKey(shown, digest, receiver),
    );
    const widened = manifest({
      version: '2.0.0',
      network: { hosts: ['api.weather.test', 'upload.weather.test', 'extra.weather.test'] },
    });
    expect(
      ghostInstallConsentKey(evaluateGhostInstallConsent(current, widened)!, digest, receiver),
    ).not.toBe(ghostInstallConsentKey(shown, digest, receiver));
  });

  it('binds the consent key to the reviewed package digest, not just identity and permissions', () => {
    const facts = evaluateGhostInstallConsent(null, manifest())!;
    const reviewed = 'a'.repeat(64);
    const replaced = 'b'.repeat(64);
    expect(ghostInstallConsentKey(facts, reviewed, null)).toBe(
      ghostInstallConsentKey(facts, reviewed, null),
    );
    expect(ghostInstallConsentKey(facts, reviewed, null)).not.toBe(
      ghostInstallConsentKey(facts, replaced, null),
    );
  });

  it('binds update consent to the reviewed receiver receipt, not just version and permissions', () => {
    const facts = evaluateGhostInstallConsent(
      installed(manifest()),
      manifest({ version: '2.0.0', network: { hosts: ['api.weather.test', 'upload.weather.test'] } }),
    )!;
    const digest = 'a'.repeat(64);
    const reviewed = 'approved:00000000-0000-4000-8000-000000000001';
    const replaced = 'approved:00000000-0000-4000-8000-000000000002';
    expect(ghostInstallConsentKey(facts, digest, reviewed)).not.toBe(
      ghostInstallConsentKey(facts, digest, replaced),
    );
  });
});
