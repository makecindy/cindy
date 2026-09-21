import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveClientEndpointsStrict } from '@cindy/maker-shared/client-endpoints';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { createLogger } from '../logger.js';
import { t } from '../i18n.js';
import { observeDesktopStartupResult } from '../devStartupStatus.js';
import { defaultPtySpawn } from '../terminal/ptyFactory.js';
import { makeTestEnvironment } from './testRunner.js';
import { getMakeRuntimeSourceIdentity } from './runtimeVersion.js';
import { versionEntryArguments } from './versionLaunchArguments.js';
import {
  getCindyVersionLockScope,
  getCindyVersionOriginEndpoints,
  setCindyPersonalRuntime,
  setCindyVersionLockScope,
  setCindyVersionEndpointOverride,
} from './versionRuntimeIdentity.js';
import {
  assertVersionDirectory,
  migrationIdentity,
  readOriginalVersion,
  readPersonalVersion,
  readVersionJson,
  sameVersionPath,
  selectedVersion,
  selectVersion,
  verifyPersonalVersion,
  verifyPersonalVersionSync,
  versionDirectory,
  versionError,
  versionsRoot,
  VERSION_ID,
  ORIGINAL_DEV_ENV_KEYS,
  withVersionStore,
  writeVersionJson,
  type OriginalVersion,
  type VersionProfile,
} from './versionStore.js';

const log = createLogger('cindy-versions');
const FLAGS = {
  profile: '--cindy-version-profile=',
  request: '--cindy-version-launch=',
  helper: '--cindy-version-helper=',
};
const RESTORE_ORIGINAL_FLAG = '--cindy-version-original';
export interface VersionLaunchRequest {
  protocol: 1;
  id: string;
  profile: VersionProfile;
  parentPid: number;
  helperExecutable: string;
  helperAppPath: string;
  targetId: string;
  fallbackId: string;
  createdAt: number;
  state: 'pending' | 'starting' | 'ready' | 'cancelled' | 'failed';
  claimedPid?: number;
  helperPid?: number;
}
let currentId = 'original';
let request: VersionLaunchRequest | undefined;
let helper = false;
let switching = false;
/** Selection decided during dispatch; persisted by finishCindyVersionStartup() once the registry lock may be taken. */
let deferredSelection: 'original' | undefined;
let inheritedProfile: VersionProfile | undefined;
let forwardedArguments: string[] = [];
let bufferedUrls: string[] = [];
let bufferedFiles: string[] = [];
const bufferUrl = (event: { preventDefault(): void }, url: string) => {
  event.preventDefault();
  if (bufferedUrls.length < 16) bufferedUrls.push(url);
};
const bufferFile = (event: { preventDefault(): void }, file: string) => {
  event.preventDefault();
  if (bufferedFiles.length < 16) bufferedFiles.push(file);
};

/** Stop buffering only after the existing handlers have been installed. Nothing is persisted. */
export function deliverCindyVersionOpenEvents(): void {
  app.removeListener('open-url', bufferUrl);
  app.removeListener('open-file', bufferFile);
  for (const url of bufferedUrls.splice(0)) app.emit('open-url', { preventDefault() {} }, url);
  for (const file of bufferedFiles.splice(0)) app.emit('open-file', { preventDefault() {} }, file);
  forwardedArguments = [];
}
function handoffArguments(): string[] {
  const files = bufferedFiles.flatMap((file) => {
    try {
      return fs.statSync(file).isDirectory() ? ['--open-folder', file] : [file];
    } catch {
      return [];
    }
  });
  return versionEntryArguments([...forwardedArguments, ...bufferedUrls, ...files]);
}
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const getCurrentCindyVersionId = () => currentId;
export const isCindyVersionSwitching = () => switching;
export const isCindyVersionLaunchPending = () => !!request && !helper;
export function watchCindyVersionStartupResult(): void {
  if (!request || helper) return;
  observeDesktopStartupResult((ready) => {
    if (ready) void markCindyVersionReady().catch(() => {});
    else {
      const file = versionRequestPath(request!.profile.userData, request!.id);
      const value = readVersionJson<VersionLaunchRequest>(file);
      if (value?.state === 'starting' && value.claimedPid === process.pid)
        writeVersionJson(file, { ...value, state: 'failed' });
    }
  });
}
export const versionRequestPath = (profile: string, id: string) => {
  if (!VERSION_ID.test(id)) throw versionError('unavailable');
  return path.join(versionsRoot(profile), 'launches', id + '.json');
};
function parseVersionEndpoints(text: string, region: VersionProfile['region']) {
  const parsed = resolveClientEndpointsStrict(text, { allowHttp: true });
  const expected = region === 'global' ? 'global' : 'cn';
  if (
    !parsed.ok ||
    (parsed.region !== undefined && parsed.region !== null && parsed.region !== expected)
  )
    throw versionError('unavailable');
  return parsed;
}
export function currentVersionProfile(): VersionProfile {
  let endpointSnapshot = inheritedProfile?.endpointSnapshot;
  if (currentId === 'original') {
    const resolved = getCindyVersionOriginEndpoints();
    if (resolved) endpointSnapshot = resolved.snapshot;
    else if (!app.isPackaged && process.env.XDT_ENDPOINTS_CDN !== '1') {
      const root = path.resolve(app.getAppPath(), '..', '..');
      const file = process.env.XDT_ENDPOINT_MANIFEST_FILE?.trim();
      const location = file ? path.resolve(root, file) : path.join(root, 'config', 'endpoint.json');
      if (fs.statSync(location).size > 256 * 1024) throw versionError('unavailable');
      const parsed = parseVersionEndpoints(fs.readFileSync(location, 'utf8'), CURRENT_CINDY_REGION);
      endpointSnapshot = {
        manifestText: JSON.stringify({
          schemaVersion: 1,
          region: parsed.region ?? (CURRENT_CINDY_REGION === 'global' ? 'global' : 'cn'),
          ...parsed.endpoints,
        }),
        local: process.env.XDT_DESKTOP_DEV_MODE === 'local',
      };
    } else endpointSnapshot = undefined;
  }
  return {
    userData: app.getPath('userData'),
    appName: app.getName(),
    region: CURRENT_CINDY_REGION,
    deviceId: process.env.XDT_DEVICE_ID_OVERRIDE,
    passive: process.env.XDT_SCHEDULER_PASSIVE === '1',
    ...(endpointSnapshot ? { endpointSnapshot } : {}),
  };
}
function assertProfile(profile: VersionProfile): void {
  if (
    !profile ||
    !path.isAbsolute(profile.userData) ||
    !['Cindy', 'CindyDev'].includes(profile.appName) ||
    !['cn', 'global', 'dev'].includes(profile.region) ||
    (profile.deviceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(profile.deviceId))
  )
    throw versionError('unavailable');
  const marker = path.join(profile.userData, 'keychain-identity');
  let name = 'Cindy';
  try {
    if (fs.lstatSync(marker).isSymbolicLink()) throw versionError('unavailable');
    const value = fs.readFileSync(marker, 'utf8');
    if (!['Cindy\n', 'Cindy\r\n', 'CindyDev\n', 'CindyDev\r\n'].includes(value))
      throw versionError('unavailable');
    name = value.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (name !== profile.appName) throw versionError('unavailable');
  if (
    profile.endpointSnapshot &&
    (typeof profile.endpointSnapshot.manifestText !== 'string' ||
      profile.endpointSnapshot.manifestText.length > 256 * 1024 ||
      typeof profile.endpointSnapshot.local !== 'boolean')
  )
    throw versionError('unavailable');
  if (profile.endpointSnapshot)
    parseVersionEndpoints(profile.endpointSnapshot.manifestText, profile.region);
}
function argvValue(prefix: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
function targetExecutable(item: VersionLaunchRequest): string {
  if (item.targetId === 'original') {
    const original = readOriginalVersion(item.profile.userData);
    if (!original) throw versionError('unavailable');
    return original.executable;
  }
  const target = readPersonalVersion(item.profile.userData, item.targetId);
  return path.join(versionDirectory(item.profile.userData, target.id), target.executable);
}
/** Narrow, owner-created handoff, not a general packaged profile/env override. Runs before credentials load. */
export function prepareCindyVersionStartup(): void {
  const profilePath = argvValue(FLAGS.profile) ?? process.env.CINDY_VERSION_PROFILE;
  const id =
    argvValue(FLAGS.helper) ?? argvValue(FLAGS.request) ?? process.env.CINDY_VERSION_LAUNCH;
  helper = !!argvValue(FLAGS.helper);
  if (id || profilePath) {
    if (!id || !profilePath || !path.isAbsolute(profilePath)) throw versionError('unavailable');
    assertVersionDirectory(profilePath, path.join(versionsRoot(profilePath), 'launches'));
    const item = readVersionJson<VersionLaunchRequest>(versionRequestPath(profilePath, id));
    const devRestart =
      !helper &&
      !app.isPackaged &&
      item?.state === 'ready' &&
      item.targetId === 'original' &&
      !!item.helperPid &&
      pidAlive(item.helperPid);
    if (
      !item ||
      item.protocol !== 1 ||
      item.id !== id ||
      !sameVersionPath(item.profile.userData, profilePath) ||
      (!devRestart && Date.now() - item.createdAt > 30 * 60_000) ||
      (!devRestart && !['pending', 'starting'].includes(item.state)) ||
      !Number.isSafeInteger(item.parentPid) ||
      item.parentPid <= 0
    )
      throw versionError('unavailable');
    assertProfile(item.profile);
    const expected = helper ? item.helperExecutable : targetExecutable(item);
    if (!sameVersionPath(fs.realpathSync(expected), fs.realpathSync(process.execPath)))
      throw versionError('unavailable');
    if (!app.isPackaged) {
      const expectedApp = helper ? item.helperAppPath : readOriginalVersion(profilePath)?.appPath;
      if (!expectedApp || !sameVersionPath(app.getAppPath(), expectedApp))
        throw versionError('unavailable');
    }
    request = devRestart ? undefined : item;
    if (devRestart) applyProfile(item.profile);
    if (helper) {
      item.helperPid = process.pid;
      writeVersionJson(versionRequestPath(profilePath, id), item);
    }
    if (!helper && !devRestart) {
      if (item.state !== 'starting' || item.claimedPid) throw versionError('unavailable');
      currentId = item.targetId;
      item.claimedPid = process.pid;
      writeVersionJson(versionRequestPath(profilePath, id), item);
    }
  } else if (app.isPackaged) {
    // Finder/direct execution of a saved .app must retain its original profile too.
    let directory = path.dirname(process.execPath);
    for (let depth = 0; depth < 7; depth++, directory = path.dirname(directory)) {
      const id = path.basename(directory);
      if (
        !VERSION_ID.test(id) ||
        path.basename(path.dirname(directory)) !== 'versions' ||
        path.basename(path.dirname(path.dirname(directory))) !== 'cindy-versions'
      )
        continue;
      const profile = path.dirname(path.dirname(path.dirname(directory)));
      const item = readPersonalVersion(profile, id);
      if (!sameVersionPath(path.join(directory, item.executable), process.execPath))
        throw versionError('unavailable');
      const profileIdentity = readOriginalVersion(profile)?.profile ?? item.profile;
      assertProfile(profileIdentity);
      currentId = item.id;
      applyProfile(profileIdentity);
      setCindyPersonalRuntime(true);
      break;
    }
  }
  if (request) applyProfile(request.profile);
  forwardedArguments = versionEntryArguments(process.argv);
  if (id && process.env.CINDY_VERSION_FORWARD_ARGUMENTS) {
    try {
      const forwarded = JSON.parse(process.env.CINDY_VERSION_FORWARD_ARGUMENTS);
      if (Array.isArray(forwarded) && forwarded.every((value) => typeof value === 'string'))
        forwardedArguments.push(...versionEntryArguments(forwarded));
    } catch {}
  }
  if (!helper && process.platform !== 'darwin')
    process.argv.push(...forwardedArguments.filter((arg) => !process.argv.includes(arg)));
  if (!helper && process.platform === 'darwin') {
    for (let i = 0; i < forwardedArguments.length; i++) {
      const arg = forwardedArguments[i];
      if (arg.startsWith('--open-')) {
        const file = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : forwardedArguments[++i];
        if (file && !bufferedFiles.includes(file)) bufferedFiles.push(file);
      } else if (path.isAbsolute(arg)) {
        if (!bufferedFiles.includes(arg)) bufferedFiles.push(arg);
      } else if (!bufferedUrls.includes(arg)) bufferedUrls.push(arg);
    }
  }
  app.on('open-url', bufferUrl);
  app.on('open-file', bufferFile);
  // Handoff arguments authorize this launch only. Ordinary relaunches must not replay them.
  process.argv = process.argv.filter(
    (arg) => !Object.values(FLAGS).some((prefix) => arg.startsWith(prefix)),
  );
  delete process.env.CINDY_VERSION_PROFILE;
  delete process.env.CINDY_VERSION_LAUNCH;
  delete process.env.CINDY_VERSION_FORWARD_ARGUMENTS;
  setCindyPersonalRuntime(currentId !== 'original' && !helper);
}
function applyProfile(profile: VersionProfile): void {
  if (profile.region !== CURRENT_CINDY_REGION) throw versionError('incompatible');
  inheritedProfile = profile;
  setCindyVersionEndpointOverride(profile.endpointSnapshot);
  app.setPath('userData', profile.userData);
  app.setName(profile.appName);
  if (profile.deviceId) process.env.XDT_DEVICE_ID_OVERRIDE = profile.deviceId;
  else delete process.env.XDT_DEVICE_ID_OVERRIDE;
  if (profile.passive) process.env.XDT_SCHEDULER_PASSIVE = '1';
  else delete process.env.XDT_SCHEDULER_PASSIVE;
}

export function describeOriginalVersion(node?: string): OriginalVersion {
  const profile = currentVersionProfile();
  if (currentId !== 'original') {
    const existing = readOriginalVersion(profile.userData);
    if (!existing) throw versionError('unavailable');
    return existing;
  }
  const root = path.resolve(app.getAppPath(), '..', '..');
  const previous = readOriginalVersion(profile.userData);
  const original: OriginalVersion = {
    protocol: 1,
    version: app.getVersion(),
    ...getMakeRuntimeSourceIdentity(),
    profile,
    executable: process.execPath,
    appPath: app.getAppPath(),
    resources: app.isPackaged ? process.resourcesPath : app.getAppPath(),
    migrationHash: migrationIdentity(
      path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'drizzle'),
    ),
    ...(!app.isPackaged
      ? {
          development: {
            root,
            node: node ?? previous?.development?.node ?? '',
            mode:
              process.env.XDT_DESKTOP_DEV_MODE === 'local'
                ? ('local' as const)
                : ('remote' as const),
            environment: Object.fromEntries(
              ORIGINAL_DEV_ENV_KEYS.flatMap((key) =>
                process.env[key] !== undefined ? [[key, process.env[key]!]] : [],
              ),
            ),
          },
        }
      : {}),
  };
  return original;
}
export async function rememberOriginalVersion(node?: string): Promise<OriginalVersion> {
  const original = describeOriginalVersion(node);
  if (currentId === 'original')
    await withVersionStore(original.profile.userData, async () =>
      writeVersionJson(
        path.join(versionsRoot(original.profile.userData), 'original.json'),
        original,
      ),
    );
  recordCindyVersionActive();
  return original;
}
/** Called only by the running owner or after Electron grants its existing single-instance lock. */
export function recordCindyVersionActive(): void {
  const profile = app.getPath('userData');
  if (helper || !fs.existsSync(versionsRoot(profile))) return;
  assertVersionDirectory(profile, versionsRoot(profile));
  const scope =
    getCindyVersionLockScope() ??
    (app.isPackaged ? 'profile' : process.env.XDT_SCHEDULER_PASSIVE === '1' ? 'none' : 'dev');
  writeVersionJson(path.join(versionsRoot(profile), 'active.json'), {
    pid: process.pid,
    id: currentId,
    scope,
  });
}
/**
 * Called by bootstrap-electron once this process owns the single-instance lock. Registry
 * writes that take the cross-process lock (real I/O) live here, not in
 * dispatchCindyVersionStartup(): that function runs before bootstrap-electron is loaded and
 * must not yield to the event loop, or Electron becomes ready before bootstrap installs its
 * privileged schemes and 'ready' listener.
 */
export function finishCindyVersionStartup(): void {
  recordCindyVersionActive();
  if (helper) return;
  const profile = app.getPath('userData');
  const selection = deferredSelection;
  deferredSelection = undefined;
  void (async () => {
    if (selection) await selectVersion(profile, selection);
    if (
      currentId === 'original' &&
      !request &&
      fs.existsSync(path.join(versionsRoot(profile), 'original.json'))
    )
      await rememberOriginalVersion();
  })().catch((error) => {
    log.warn('Failed to update the recorded original version', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Helper is a separate headless Electron process, so it survives normal app shutdown without RunAsNode. */
export async function startVersionHandoff(
  targetId: string,
  canSwitch: () => Promise<boolean> = async () => true,
): Promise<void> {
  if (switching) throw versionError('busy');
  const profile = currentVersionProfile();
  // Startup dispatch precedes the asynchronous original.json refresh. Use this
  // process's identity so an upgrade cannot launch a now-incompatible personal app.
  const original =
    currentId === 'original' ? describeOriginalVersion() : readOriginalVersion(profile.userData);
  if (!original) throw versionError('unavailable');
  if (targetId !== 'original') await verifyPersonalVersion(profile.userData, targetId, original);
  else if (
    !fs.existsSync(original.executable) ||
    (original.development && !fs.existsSync(original.development.node))
  )
    throw versionError('unavailable');
  if (
    targetId === 'original' &&
    currentId !== 'original' &&
    readPersonalVersion(profile.userData, currentId).migrationHash !==
      migrationIdentity(path.join(original.resources, 'drizzle'))
  )
    throw versionError('incompatible');
  if (!(await canSwitch())) throw versionError('busy');
  const item: VersionLaunchRequest = {
    protocol: 1,
    id: randomUUID(),
    profile,
    parentPid: process.pid,
    helperExecutable: process.execPath,
    helperAppPath: app.getAppPath(),
    targetId,
    fallbackId: currentId,
    createdAt: Date.now(),
    state: 'pending',
  };
  await withVersionStore(profile.userData, async () => {
    const pending = path.join(versionsRoot(profile.userData), 'pending.json');
    const previous = readVersionJson<{ id: string; pid: number }>(pending);
    if (previous && pidAlive(previous.pid)) throw versionError('busy');
    if (currentId === 'original')
      writeVersionJson(path.join(versionsRoot(profile.userData), 'original.json'), original);
    writeVersionJson(versionRequestPath(profile.userData, item.id), item);
    writeVersionJson(pending, { id: item.id, pid: process.pid });
  });
  switching = true;
  const args = [
    ...(!app.isPackaged ? [app.getAppPath()] : []),
    FLAGS.profile + profile.userData,
    FLAGS.helper + item.id,
  ];
  try {
    const helperPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...makeTestEnvironment(process.env),
          CINDY_VERSION_FORWARD_ARGUMENTS: JSON.stringify(handoffArguments()),
        },
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve(child.pid!);
      });
    });
    const deadline = Date.now() + 10_000;
    while (
      readVersionJson<VersionLaunchRequest>(versionRequestPath(profile.userData, item.id))
        ?.helperPid !== helperPid
    ) {
      if (!pidAlive(helperPid) || Date.now() >= deadline) throw versionError('launchFailed');
      await delay(100);
    }
    if (!(await canSwitch())) throw versionError('busy');
    await withVersionStore(profile.userData, async () =>
      writeVersionJson(path.join(versionsRoot(profile.userData), 'pending.json'), {
        id: item.id,
        pid: helperPid,
      }),
    );
  } catch (error) {
    switching = false;
    item.state = 'cancelled';
    writeVersionJson(versionRequestPath(profile.userData, item.id), item);
    throw error;
  }
}

async function launchTarget(
  item: VersionLaunchRequest,
): Promise<{ stop(): Promise<void>; closed: Promise<void> }> {
  const original = readOriginalVersion(item.profile.userData);
  if (!original) throw versionError('unavailable');
  const directory = versionRequestPath(item.profile.userData, item.id);
  item.state = 'starting';
  delete item.claimedPid;
  writeVersionJson(directory, item);
  const environment = {
    ...makeTestEnvironment(process.env),
    CINDY_VERSION_PROFILE: item.profile.userData,
    CINDY_VERSION_LAUNCH: item.id,
    CINDY_VERSION_FORWARD_ARGUMENTS: JSON.stringify(handoffArguments()),
  };
  if (item.targetId === 'original' && original.development) {
    const dev = original.development;
    if (!path.isAbsolute(dev.node)) throw versionError('unavailable');
    const child = defaultPtySpawn(
      dev.node,
      [path.join(dev.root, 'scripts', 'desktop-dev-runner.mjs'), dev.mode],
      {
        cwd: dev.root,
        env: { ...environment, ...dev.environment },
        name: 'xterm-256color',
        cols: 160,
        rows: 30,
      },
    );
    child.onData(() => {});
    const closed = new Promise<void>((resolve) => child.onExit(() => resolve()));
    return {
      closed,
      stop: async () => {
        child.kill();
        await closed;
      },
    };
  }
  const executable =
    item.targetId === 'original'
      ? original.executable
      : await verifyPersonalVersion(item.profile.userData, item.targetId, original).then(
          (version) =>
            path.join(versionDirectory(item.profile.userData, version.id), version.executable),
        );
  // Executing the precise binary inside .app preserves bundle identity and gives us an owned PID.
  const child = spawn(
    executable,
    [FLAGS.profile + item.profile.userData, FLAGS.request + item.id],
    {
      cwd: path.dirname(executable),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: environment,
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    closed,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await closed;
    },
  };
}

async function runVersionHelper(item: VersionLaunchRequest): Promise<void> {
  await app.whenReady();
  app.dock?.hide();
  const file = versionRequestPath(item.profile.userData, item.id);
  const deadline = Date.now() + 60_000;
  while (pidAlive(item.parentPid) && Date.now() < deadline) {
    if (readVersionJson<VersionLaunchRequest>(file)?.state === 'cancelled') return;
    await delay(200);
  }
  if (pidAlive(item.parentPid)) {
    item.state = 'cancelled';
    writeVersionJson(file, item);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let child: Awaited<ReturnType<typeof launchTarget>> | undefined;
    try {
      child = await launchTarget(item);
      let closed = false;
      void child.closed.then(() => {
        closed = true;
      });
      const readyDeadline =
        Date.now() +
        (item.targetId === 'original' && readOriginalVersion(item.profile.userData)?.development
          ? 25 * 60_000
          : 120_000);
      while (Date.now() < readyDeadline) {
        const latest = readVersionJson<VersionLaunchRequest>(file);
        if (latest?.state === 'ready' && latest.targetId === item.targetId) {
          forwardedArguments = [];
          bufferedUrls = [];
          bufferedFiles = [];
          if (
            item.targetId === 'original' &&
            readOriginalVersion(item.profile.userData)?.development
          )
            await child.closed;
          return;
        }
        if (closed || latest?.state === 'failed') break;
        await delay(200);
      }
      throw versionError('launchFailed');
    } catch (error) {
      item.state = 'cancelled';
      writeVersionJson(file, item);
      if (child) await child.stop();
      log.warn('Version launch failed; retaining existing application data', { attempt });
      if (attempt === 0 && item.targetId !== item.fallbackId) {
        item.targetId = item.fallbackId;
        continue;
      }
      item.state = 'failed';
      writeVersionJson(file, item);
      // Preserve the explicit original-version recovery entry even if a personal build is broken.
      await selectVersion(item.profile.userData, 'original');
      dialog.showErrorBox('Cindy', t('cindyMake.versions.errors.recovery'));
    }
  }
}

/**
 * A handoff that failed after Electron became ready cannot fall back to opening the original in
 * this process: bootstrap-electron is not loaded yet and its pre-ready registrations would be
 * rejected. Reset the selection so the next launch opens the original, then leave.
 */
async function recoverOriginalAfterReady(profile: string): Promise<true> {
  await selectVersion(profile, 'original').catch(() => {});
  if (app.isPackaged) {
    app.relaunch({
      args: [
        ...process.argv.slice(1).filter((arg) => arg !== RESTORE_ORIGINAL_FLAG),
        RESTORE_ORIGINAL_FLAG,
      ],
    });
    app.exit(0);
    return true;
  }
  // Dev cannot relaunch itself: Forge/Vite exit with this process. The dev runner reports the
  // exit; the reset selection makes the next start open the original.
  process.stderr.write(
    '[cindy] personal version handoff failed after Electron became ready; ' +
      'the selection was reset to the original. Start Dev again.\n',
  );
  app.exit(1);
  return true;
}

/**
 * Called after dev profile resolution, before the database, single-instance lock and main windows.
 *
 * Every path that returns false continues into bootstrap-electron, whose module top level
 * registers privileged schemes and the 'ready' listener; both require Electron not to be ready
 * yet. Those paths therefore never yield to the event loop: registry reads are synchronous,
 * the personal-version self-check hashes synchronously, and registry writes are deferred to
 * finishCindyVersionStartup(). Only paths that end in app.exit() may await real I/O.
 */
export async function dispatchCindyVersionStartup(): Promise<boolean> {
  if (helper && request) {
    try {
      await runVersionHelper(request);
    } finally {
      app.exit(0);
    }
    return true;
  }
  const profile = app.getPath('userData');
  if (fs.existsSync(versionsRoot(profile))) {
    if (!request) {
      const pending = readVersionJson<{ id: string; pid: number }>(
        path.join(versionsRoot(profile), 'pending.json'),
      );
      if (pending && pidAlive(pending.pid)) {
        const pendingRequest = readVersionJson<VersionLaunchRequest>(
          versionRequestPath(profile, pending.id),
        );
        if (pendingRequest && ['pending', 'starting'].includes(pendingRequest.state)) {
          app.exit(0);
          return true;
        }
      }
    }
    const active = readVersionJson<{ pid: number; scope?: string }>(
      path.join(versionsRoot(profile), 'active.json'),
    );
    if (active && active.pid !== process.pid && pidAlive(active.pid)) {
      if (active.scope === 'none') throw versionError('busy');
      // Let Electron's existing second-instance path focus the running version.
      setCindyVersionLockScope(active.scope === 'dev' ? 'dev' : 'profile');
      return false;
    }
    setCindyVersionLockScope('profile');
  }
  const restoreOriginal = process.argv.includes(RESTORE_ORIGINAL_FLAG);
  if (currentId !== 'original') {
    const original = readOriginalVersion(profile);
    if (!original) throw versionError('unavailable');
    verifyPersonalVersionSync(profile, currentId, original);
    if (!request) {
      const selected = restoreOriginal ? 'original' : selectedVersion(profile);
      if (selected !== currentId) {
        await startVersionHandoff(selected);
        app.exit(0);
        return true;
      }
    }
  }
  if (
    currentId === 'original' &&
    !request &&
    fs.existsSync(path.join(versionsRoot(profile), 'original.json'))
  ) {
    if (restoreOriginal) deferredSelection = 'original';
    try {
      const selected = restoreOriginal ? 'original' : selectedVersion(profile);
      if (selected !== 'original') {
        await startVersionHandoff(selected);
        app.exit(0);
        return true;
      }
    } catch (error) {
      deferredSelection = 'original';
      log.warn('Personal version selection unavailable; opening the original', {
        error: error instanceof Error ? error.message : String(error),
      });
      // A failure before the handoff's first real I/O (unreadable selection, missing version
      // directory) leaves Electron not ready, so the original can still open in this process.
      if (app.isReady()) return recoverOriginalAfterReady(profile);
    }
  }
  return false;
}

export async function markCindyVersionReady(): Promise<void> {
  if (!request || helper) return;
  const file = versionRequestPath(request.profile.userData, request.id);
  const latest = readVersionJson<VersionLaunchRequest>(file);
  if (!latest || latest.state !== 'starting' || latest.claimedPid !== process.pid) return;
  await selectVersion(request.profile.userData, currentId);
  writeVersionJson(file, { ...latest, state: 'ready' });
  await withVersionStore(request.profile.userData, async () => {
    const pending = path.join(versionsRoot(request!.profile.userData), 'pending.json');
    if (readVersionJson<{ id: string }>(pending)?.id === request!.id) fs.unlinkSync(pending);
  });
}
