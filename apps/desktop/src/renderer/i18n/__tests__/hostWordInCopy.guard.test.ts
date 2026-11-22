import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Guard (static contract over the locale catalogs). Rule: the user's decision of 2026-11-18, recorded in
 * the release table (docs/host/personal-migration-release-table.md, section 4): text shown to users never
 * calls the Cindy background service "Host"; it says 「Cindy 后台服务」 / "the Cindy background service".
 * What breaks without it: a new string names that service "Host" again, a word users do not understand.
 * Scope: every value of every locale file, the word "Host" standing alone (also inside compounds such as
 * "Host-Computer"). Not matched: lowercase words (localhost, hostname, ghost, the cindy-host command) and
 * longer words (Hosted, Hosts).
 * Known blind spot: a standalone lowercase "host" is not matched either, because English copy uses it
 * for SSH and remote machines far too often to scan every hit. So a string that calls the background
 * service "host" in lowercase gets past this guard.
 *
 * "Host" with another meaning is frozen below by locale and key, grouped by meaning. The list only
 * shrinks: a new hit fails, and an entry whose key is gone or no longer says "Host" fails too, so the list
 * is trimmed instead of rotting.
 */
const HOST_WORD = /(?<![A-Za-z0-9_])Host(?![A-Za-z0-9_])/;

const OTHER_MEANINGS: ReadonlyArray<{ meaning: string; entries: Readonly<Record<string, readonly string[]>> }> = [
  {
    meaning: 'a remote machine reached over SSH or another device (settings.remote.*, ipcError.SSH_*, remote projects, remote-agent banners)',
    entries: {
      'de': [
        'ccAgent.draft.piRemoteUnsupported',
        'chat.errorBanner.piBundledNodeMissing',
        'chat.remoteError.REMOTE_LOCAL_ONLY_PROVIDER',
        'chat.upgradeBanner.description',
        'ipcError.SSH_CONFIG_AUTH_UNSUPPORTED',
        'ipcError.SSH_CONFIG_OWNERSHIP_REQUIRED',
        'ipcError.SSH_HOST_PREFS_WRITE_FAILED',
        'newChat.addRemoteProject.empty',
        'newChat.addRemoteProject.emptyPiSshFiltered',
        'newChat.addRemoteProject.hint',
        'newChat.addRemoteProject.host',
        'projectSettings.sshHost',
        'settings.remote.add.agentProxyUrlHint',
        'settings.remote.button.autoConnectTip',
        'settings.remote.button.manageKeysTip',
        'settings.remote.detail.agentProxyEnvPending',
        'settings.remote.detail.agentProxyWaiting',
        'settings.remote.empty.hint',
        'settings.remote.hostKey.review',
        'settings.remote.hostKey.updateFailed',
        'settings.remote.keys.agentTrouble.noSuchFileFix',
        'settings.remote.silentInstall.installingAgent',
        'settings.remote.silentInstall.starting',
        'settings.remote.toast.addConflict',
        'settings.remote.toast.codexSyncDoneDaemonRestartFailed',
        'settings.remote.toast.connectKeyFileMissing',
        'settings.remoteControl.description',
        'settings.remoteControl.relay.deploy.noHosts',
      ],
      'en': [
        'ipcError.SSH_HOST_KEY_MISMATCH',
        'settings.remote.detail.agentProxyWaiting',
        'settings.remote.hostKey.review',
        'settings.remote.hostKey.title',
      ],
      'es': [
        'newChat.addRemoteProject.host',
        'projectSettings.sshHost',
        'settings.remote.detail.agentProxyWaiting',
      ],
      'pt-BR': [
        'newChat.addRemoteProject.host',
        'projectSettings.sshHost',
        'settings.remote.detail.agentProxyWaiting',
      ],
    },
  },
  {
    meaning: 'the computer (and its owner) that runs a shared task, as opposed to a guest',
    entries: {
      'de': [
        'sharedTask.accessEndedBody',
        'sharedTask.host',
        'sharedTask.invitationRenew',
        'sharedTask.invitationUnavailable',
        'sharedTask.inviteNotice',
        'sharedTask.joinedManageIntro',
        'sharedTask.leaveBody',
        'sharedTask.offlineAutoClose',
        'sharedTask.permissionDenied',
        'sharedTask.remoteHostOfflineNote',
        'sharedTask.removeBody',
        'sharedTask.requestTimedOut',
        'sharedTask.roleHost',
        'sharedTask.runsOnHostDevice',
        'sharedTask.unavailable',
      ],
      'en': [
        'sharedTask.host',
        'sharedTask.roleHost',
      ],
    },
  },
  {
    meaning: 'the computer the agent operates, where the owner finishes an input step',
    entries: {
      'de': [
        'inputHandoff.failure.unreadable',
        'inputHandoff.holder.host',
        'inputHandoff.picture.hint',
        'inputHandoff.record.doneHost_one',
        'inputHandoff.record.doneHost_other',
        'inputHandoff.remoteUnavailable',
      ],
    },
  },
  {
    meaning: 'Cindy as the app that hosts plugins and gives them tools (and relays requests)',
    entries: {
      'de': [
        'forwardedRequest.sourcePresent',
        'settings.builtinTools.plugins.xdt_helper.description',
        'settings.ghosts.connections.confirmDetail',
        'settings.ghosts.perm.codeDetailHostServices',
        'settings.ghosts.perm.codeDetailNetwork',
        'settings.ghosts.perm.fsWriteDetail',
        'settings.ghosts.perm.hostTools_computerDetail',
        'settings.ghosts.perm.hostTools_discovery',
        'settings.ghosts.perm.libraryPersistDetail',
        'settings.ghosts.perm.networkSecretGhCliDetail',
        'settings.ghosts.perm.networkSecretGhostInputDetail',
        'settings.ghosts.perm.networkSecretIdentityDetail',
        'settings.ghosts.perm.networkSecretOrganizationIdentityDetail',
        'settings.ghosts.perm.nodeChildSpawn',
        'settings.ghosts.perm.uiHost',
      ],
      'en': [
        'settings.builtinTools.plugins.xdt_helper.description',
        'settings.ghosts.perm.codeDetailHostServices',
        'settings.ghosts.perm.hostTools_computerDetail',
        'settings.ghosts.perm.hostTools_discovery',
        'settings.ghosts.perm.uiHost',
      ],
    },
  },
];

const LOCALES_DIR = new URL('../locales/', import.meta.url);

/** Every string value as `locale:namespace:key`. */
function readCatalogStrings(dir: URL = LOCALES_DIR): Map<string, string> {
  const values = new Map<string, string>();
  const walk = (prefix: string, node: unknown): void => {
    if (typeof node === 'string') values.set(prefix, node);
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(prefix.endsWith(':') ? prefix + key : `${prefix}.${key}`, child);
    }
  };
  for (const locale of readdirSync(dir)) {
    for (const file of readdirSync(new URL(`${locale}/`, dir))) {
      if (!file.endsWith('.json')) continue;
      walk(`${locale}:${file.slice(0, -5)}:`, JSON.parse(readFileSync(new URL(`${locale}/${file}`, dir), 'utf8')));
    }
  }
  return values;
}

function allowed(): Set<string> {
  return new Set(OTHER_MEANINGS.flatMap(({ entries }) =>
    Object.entries(entries).flatMap(([locale, keys]) => keys.map(key => `${locale}:common:${key}`))));
}

/** Hits outside the allowlist, and allowlist entries that no longer say "Host" (or are gone). */
function checkHostWord(values: ReadonlyMap<string, string>, allowlist: ReadonlySet<string>) {
  const unexpected = [...values].filter(([id, value]) => HOST_WORD.test(value) && !allowlist.has(id)).map(([id]) => id);
  const stale = [...allowlist].filter(id => !HOST_WORD.test(values.get(id) ?? ''));
  return { unexpected, stale };
}

describe('UI copy does not call the Cindy background service "Host"', () => {
  it('says "Host" only where the frozen list records another meaning', () => {
    const { unexpected } = checkHostWord(readCatalogStrings(), allowed());
    expect(unexpected, 'Write 「Cindy 后台服务」 / "the Cindy background service" instead; if "Host" means something else here, add the key to OTHER_MEANINGS with its meaning').toEqual([]);
  });

  it('keeps no list entry whose key is gone or no longer says "Host"', () => {
    const { stale } = checkHostWord(readCatalogStrings(), allowed());
    expect(stale, 'Remove these entries from OTHER_MEANINGS').toEqual([]);
  });

  it('matches the word, not lowercase words or the cindy-host command', () => {
    const values = new Map([
      ['en:common:a', 'Restart the Host.'],
      ['en:common:b', 'Open http://localhost:3000, then run cindy-host status.'],
      ['de:common:c', 'Auf dem Host-Computer'],
      ['en:common:d', 'Hosted page, hostname and ghost'],
    ]);
    expect(checkHostWord(values, new Set()).unexpected).toEqual(['en:common:a', 'de:common:c']);
  });
});
