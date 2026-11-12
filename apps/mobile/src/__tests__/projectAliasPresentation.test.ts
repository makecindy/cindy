// Unit regression: desktop project renames must update an already-open project route title.
// Existing grouping tests do not cover a retained route hint or a mixed local/SSH group.
// Minimal input: one /repo/app route, followed by a new host alias and then its removal.
import { describe, expect, it } from 'vitest';
import type { HostProjectAliasesSnapshot } from '@cindy/maker-shared/project-alias-sync';
import { resolveMobileProjectRouteTitle } from '@/session/projectAliasPresentation';
import type { RemoteSession } from '@/session/types';

const session = { workingDir: '/repo/app', deviceLinkDeviceId: 'desktop' } as RemoteSession;
const input = {
  deviceId: 'desktop', workingDir: '/repo/app', routeTitle: '进入时旧名', sessions: [session],
};
const aliases = (name?: string): Map<string, HostProjectAliasesSnapshot> => new Map([['desktop', {
  platform: 'darwin',
  aliases: name ? [{ projectKey: 'local:/repo/app', alias: name }] : [],
}]]);

describe('project detail route title', () => {
  it('updates an already-open header and restores the directory name when its alias is removed', () => {
    expect(resolveMobileProjectRouteTitle({ ...input, projectAliases: new Map() })).toBe('进入时旧名');
    expect(resolveMobileProjectRouteTitle({ ...input, projectAliases: aliases('改名后的项目') })).toBe('改名后的项目');
    expect(resolveMobileProjectRouteTitle({ ...input, projectAliases: aliases() })).toBe('app');
  });

  it('does not assign a local alias to a mixed local and SSH project group', () => {
    expect(resolveMobileProjectRouteTitle({
      ...input,
      sessions: [session, { ...session, remoteHostId: 'ssh-a' }],
      projectAliases: aliases('本地专属名'),
    })).toBe('app');
  });
});
