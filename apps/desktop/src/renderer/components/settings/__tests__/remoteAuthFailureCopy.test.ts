import { describe, expect, it } from 'vitest';

import i18n, { SUPPORTED_LOCALES } from '../../../i18n';
import { formatRemoteAuthFailure } from '../remoteAuthFailureCopy';

type Detail = NonNullable<RemoteHostSnapshot['authFailure']>;

const KINDS: Detail['kind'][] = [
  'agent-not-loaded',
  'agent-sign-failed',
  'agent-signed-not-accepted',
  'agent-pinned',
  'agent-unpinned',
  'key-rejected',
  'generic',
];

// 列表分隔符随语言：中文与日文用「、」，不混入英文逗号（DESIGN.md §11.2）。
const IDENTITY_SEPARATOR: Record<string, string> = {
  en: ', ',
  'zh-CN': '、',
  'zh-TW': '、',
  ja: '、',
  ko: ', ',
};

function detail(kind: Detail['kind'], extra: Partial<Detail> = {}): Detail {
  return {
    kind,
    user: 'deploy',
    hostname: '10.0.0.5',
    identities: ['~/.ssh/id_ed25519_github', 'b/id_rsa'],
    ...(kind === 'agent-unpinned' ? { command: 'ssh-copy-id -p 2222 deploy@10.0.0.5' } : {}),
    ...(kind === 'key-rejected' ? { command: 'ssh-copy-id -i <public-key-file> deploy@10.0.0.5' } : {}),
    cause: 'All configured authentication methods failed',
    ...extra,
  };
}

describe('formatRemoteAuthFailure (#4201)', () => {
  it.each(SUPPORTED_LOCALES.flatMap((locale) => KINDS.map((kind) => [locale, kind] as const)))(
    '%s / %s: localized text keeps the target, identities, command and cause verbatim',
    (locale, kind) => {
      const t = i18n.getFixedT(locale);
      const d = detail(kind);
      const text = formatRemoteAuthFailure(t, d);
      expect(text).not.toMatch(/\{\{|\}\}/);
      expect(text).not.toContain('settings.remote.authFailure');
      expect(text).toContain('deploy@10.0.0.5');
      expect(text).toContain('All configured authentication methods failed');
      if (d.command) expect(text).toContain(`\`${d.command}\``);
      if (kind !== 'agent-unpinned' && kind !== 'generic') {
        expect(text).toContain(`~/.ssh/id_ed25519_github${IDENTITY_SEPARATOR[locale]}b/id_rsa`);
      }
    },
  );

  it('each non-English locale actually translates every kind (no silent English fallback)', () => {
    const en = i18n.getFixedT('en');
    for (const locale of SUPPORTED_LOCALES.filter((l) => l !== 'en')) {
      const t = i18n.getFixedT(locale);
      for (const kind of KINDS) {
        expect(formatRemoteAuthFailure(t, detail(kind)), `${locale}/${kind}`)
          .not.toBe(formatRemoteAuthFailure(en, detail(kind)));
      }
    }
  });

  it.each(['zh-CN', 'zh-TW'])('%s identity list has no ASCII comma', (locale) => {
    const text = formatRemoteAuthFailure(i18n.getFixedT(locale), detail('agent-pinned', { cause: undefined }));
    expect(text).toContain('（IdentityFile：~/.ssh/id_ed25519_github、b/id_rsa）');
    expect(text).not.toContain(',');
  });

  it('omits the identity fragment and the cause suffix when they are absent', () => {
    const t = i18n.getFixedT('en');
    const text = formatRemoteAuthFailure(t, detail('agent-pinned', { identities: [], cause: undefined }));
    expect(text).toBe(
      'Authentication failed for deploy@10.0.0.5 with the configured identity set. Verify that identity’s public key is installed on the remote, re-add this host with the right identity, or load the matching key with `ssh-add` if it is not in the agent.',
    );
    expect(text).not.toContain('IdentityFile');
    expect(text).not.toContain('(ssh:');
  });

  it('localized signed-but-not-accepted copy never claims every key was rejected', () => {
    const text = formatRemoteAuthFailure(i18n.getFixedT('en'), detail('agent-signed-not-accepted'));
    expect(text).not.toContain('every key');
    expect(text).not.toContain('public key is installed');
  });
});
