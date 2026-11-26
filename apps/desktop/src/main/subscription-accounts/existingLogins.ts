import { randomUUID } from 'node:crypto';
import { opendir, realpath, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import type { ExistingLogin, LinkedLogin, SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getUserDataDir } from '../userDataPath.js';
import { readExistingLogin } from './nativeCli.js';
import { loginDirectoryKey, loginIdentityKey, readPool } from './store.js';
import { alreadyUsesLogin, attachExternalLogin, offerSystemLogin, runSubscriptionAccountCommand } from './runtime.js';

// Only the execution host can mint a selection. Never accept a directory from an attach request.
const reviews = new Map<string, { owner: string; provider: SubscriptionProvider; login: LinkedLogin; until: number }>();
const cliHome = (provider: SubscriptionProvider) => provider === 'anthropic' ? '.claude' : '.codex';

/** The native/default profile has its own explicit binding; Cindy-managed homes belong to
 * their original owner. Resolve links before classifying a user-selected external profile. */
async function externalDirectory(input: string) {
  if (!path.isAbsolute(input)) throw new Error('Invalid profile');
  const directory = await realpath(input);
  const managedRoot = await realpath(getUserDataDir());
  const home = await realpath(homedir());
  const relative = path.relative(managedRoot, directory);
  const insideManagedRoot = relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  if (insideManagedRoot
    || directory === home || path.dirname(directory) === directory
    || directory.split(path.sep).some(part => /^\.(?:claude|codex)-cindy-/i.test(part))
    || !(await stat(directory)).isDirectory()) throw new Error('Invalid external profile');
  return directory;
}

export function existingLoginSession(provider: SubscriptionProvider) {
  const owner = activeOwnerScopeKey();
  const assertCurrent = () => {
    if (!getActiveAppSession().dataOwnerId || owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Owner changed');
  };
  assertCurrent();
  async function inspect(input: string) {
    assertCurrent();
    const directory = await externalDirectory(input);
    assertCurrent();
    const system = path.relative(path.join(await realpath(homedir()), cliHome(provider)), directory) === '';
    if (system && !offerSystemLogin(provider, true)) return null;
    assertCurrent();
    const verified = await readExistingLogin(provider, directory);
    assertCurrent();
    if (!verified) return null;
    return { login: verified.login, candidate: { identity: verified.login.identity, directory, plan: verified.plan }, system };
  }
  return {
    computer: hostname(),
    assertCurrent,
    async discover() {
      const pool = readPool(provider);
      const ignored = new Set(pool?.dismissedLogins);
      for (const account of pool?.accounts ?? []) {
        if (account.linkedLogin) ignored.add(loginDirectoryKey(account.linkedLogin.directory));
      }
      const candidates: ExistingLogin[] = [];
      const seen = new Set<string>();
      const base = await realpath(homedir());
      const entries = await opendir(base);
      let probes = 0;
      for await (const entry of entries) {
        const system = entry.name === cliHome(provider);
        if (!entry.isDirectory() || (system ? !offerSystemLogin(provider, false)
          : !entry.name.startsWith(cliHome(provider) + '-') || /-cindy-/i.test(entry.name))) continue;
        const directory = path.join(base, entry.name);
        if (ignored.has(loginDirectoryKey(directory))) continue;
        assertCurrent();
        const result = await inspect(directory).catch(() => null);
        assertCurrent();
        if (result && !ignored.has(loginIdentityKey(result.login)) && !alreadyUsesLogin(provider, result.login)) {
          const key = result.login.accountKey ?? result.login.identity.toLowerCase();
          if (!seen.has(key)) candidates.push(review(result));
          seen.add(key);
        }
        // Bound CLI launches for one settings visit. Other locations remain selectable.
        if (++probes >= 12) break;
      }
      assertCurrent();
      return candidates;
    },
    async pick(directory: string) {
      const result = await inspect(directory);
      if (!result) throw new Error('No verified subscription');
      return [{ ...review(result), connected: alreadyUsesLogin(provider, result.login) }];
    },
    async attach(receipt: string) {
      const reviewed = reviews.get(receipt);
      if (!reviewed || reviewed.provider !== provider || reviewed.owner !== owner || reviewed.until <= Date.now())
        throw new Error('Invalid review');
      reviews.delete(receipt);
      const result = await inspect(reviewed.login.directory);
      if (!result || result.login.directory !== reviewed.login.directory
        || result.login.identity.toLowerCase() !== reviewed.login.identity.toLowerCase()
        || result.login.accountKey !== reviewed.login.accountKey) throw new Error('Account changed');
      if (result.system) {
        if (!offerSystemLogin(provider, true)) throw new Error('System login unavailable');
        await runSubscriptionAccountCommand({ action: 'connect', target: 'default', providerId: provider, loginKey: randomUUID() }, undefined, result.login);
      } else {
        await attachExternalLogin(provider, result.login, assertCurrent);
      }
      assertCurrent();
    },
  };

  function review(result: NonNullable<Awaited<ReturnType<typeof inspect>>>): ExistingLogin {
    const now = Date.now();
    for (const [key, entry] of reviews) {
      if (entry.owner !== owner || entry.until <= now) reviews.delete(key);
    }
    if (reviews.size >= 256) reviews.delete(reviews.keys().next().value!);
    const receipt = randomUUID();
    reviews.set(receipt, { owner, provider, login: result.login, until: now + 10 * 60_000 });
    return { ...result.candidate, receipt };
  }
}
