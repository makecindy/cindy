import { expect, it } from 'vitest';
import { allowWebsiteNavigation, normalizeBrowserAddress } from '@/session/browserAddress';
import { interceptSnapshotNavigation } from '@/session/htmlNavigationPolicy';

it.each([
  [' example.com/path?q=1#part ', 'https://example.com/path?q=1#part'],
  ['http://localhost:8080/', 'http://localhost:8080/'],
  ['example.com:8443/test', 'https://example.com:8443/test'],
  ['https://example.com/中文', 'https://example.com/%E4%B8%AD%E6%96%87'],
])('normalizes native address submission %s', (input, expected) => {
  expect(normalizeBrowserAddress(input)).toBe(expected);
});
it.each(['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/a', 'tel:123', 'about:blank', 'https://user:pass@example.com', 'hello world', '', '/Users/dash/file.html', 'https:\\example.com'])('rejects non-web or ambiguous input %s', input => {
  expect(normalizeBrowserAddress(input)).toBeNull();
  expect(allowWebsiteNavigation(input)).toBe(false);
});
it('does not relax the file snapshot navigation gate when native address entry accepts a site', () => {
  const url = normalizeBrowserAddress('example.com')!;
  expect(allowWebsiteNavigation(url)).toBe(true);
  expect(interceptSnapshotNavigation(url, 'http://127.0.0.1:9000/__cindy/private', ['/index.html'], true)).toBe(false);
  expect(allowWebsiteNavigation('example.com')).toBe(false);
});
