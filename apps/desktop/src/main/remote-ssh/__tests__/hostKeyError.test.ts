import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPreferredSystemLanguages: () => ['en'] } }));

import { setMainLocale } from '../../i18n.js';
import { SUPPORTED_LOCALES } from '../../../shared/locale.js';
import { formatHostKeyError } from '../host-key-error.js';

describe('localized host key errors', () => {
  it.each(SUPPORTED_LOCALES)('includes the actual path and entry key in %s', (locale) => {
    setMainLocale(locale);
    const filePath = String.raw`D:\Cindy Data\remote-ssh\known-hosts.json`;
    const message = formatHostKeyError({
      kind: 'mismatch',
      host: 'example.com:2222',
      fingerprint: 'SHA256:new',
      filePath,
    });
    expect(message).toContain(filePath);
    expect(message).toContain('"example.com:2222"');
    expect(message).toContain('SHA256:new');
    expect(message).toContain('~/.ssh/known_hosts');
    expect(message).not.toMatch(/\{\{|settings\.remote\.hostKeyError/);
  });

  it('provides the requested safe repair steps in Chinese', () => {
    setMainLocale('zh-CN');
    const message = formatHostKeyError({
      kind: 'mismatch',
      host: 'host:22',
      fingerprint: 'SHA256:new',
      filePath: '/data/known-hosts.json',
    });
    expect(message).toContain('先退出 Cindy，只删除这个键，保留文件和其他主机');
    expect(message).toContain('不要删除整个文件');
  });

  it.each(['read', 'write'] as const)(
    'keeps the actual %s failure separate from a key change',
    (kind) => {
      setMainLocale('zh-CN');
      const message = formatHostKeyError({
        kind,
        host: 'host:22',
        filePath: '/data/known-hosts.json',
        reason: 'EACCES',
      });
      expect(message).toContain('EACCES');
      expect(message).toContain('/data/known-hosts.json');
      expect(message).not.toContain('删除');
    },
  );
});
