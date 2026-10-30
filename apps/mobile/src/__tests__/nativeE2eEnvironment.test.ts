import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readSimEnvironment } from '../../scripts/lib/sim-environment.mjs';
import { posix, resolve } from 'node:path';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('native e2e environment', () => {
  it.each([
    [undefined, 'providers:email-only', 'providers:email-only'],
    ['', 'providers:email-only', ''],
    ['   ', 'providers:email-only', ''],
    ['providers:email-only', 'another-scenario', 'providers:email-only'],
    [undefined, undefined, ''],
  ])('records shell scenario %j over dotenv scenario %j as %j', (shell, dotenv, expected) => {
    const mobileDir = mkdtempSync(resolve(tmpdir(), 'cindy-scenario-'));
    try {
      if (dotenv !== undefined) writeFileSync(resolve(mobileDir, '.env'), `EXPO_PUBLIC_LOGIN_SCENARIO=${dotenv}\n`);
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'development', ...(shell === undefined ? {} : { EXPO_PUBLIC_LOGIN_SCENARIO: shell }) };
      expect(readSimEnvironment(mobileDir, {}, env).loginScenario).toBe(expected);
    } finally { rmSync(mobileDir, { recursive: true, force: true }); }

  });

  it.each([false, true])('preserves custom-port ownership when occupied=%s', async (occupied) => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/sim-start.mjs'), 'utf8');
    const start = source.indexOf("const args = ['exec', 'expo', 'start'");
    if (start < 0) throw new Error('script workflow entry missing');
    const exitCallbacks: Array<() => void> = [];
    const child = {
      pid: 4242,
      once: (event: string, callback: () => void) => { if (event === 'exit') exitCallbacks.push(callback); },
      on: vi.fn(),
    };
    const spawn = vi.fn(() => child);
    const writeMetroOwner = vi.fn();
    const clearMetroOwner = vi.fn();
    const portInUse = vi.fn(async () => occupied);
    const error = vi.fn();
    const execution = runInNewContext(`(async () => { ${source.slice(start)} })()`, {
      DEFAULT_PORT: 8081, portArgs: { port: 8082, passthrough: [] }, portInUse,
      ensureAndroidTarget: vi.fn(), spawn, writeMetroOwner, clearMetroOwner,
      console: { log: vi.fn(), error },
      process: { env: {}, exit: (code: number) => { throw new Error(`exit:${code}`); } },
      resolvePnpmInvocation: () => ({ command: 'pnpm', args: [] }),
      usablePnpmExecPath: () => undefined, existsSync: () => false,
      mobileDir: '/repo/apps/mobile', worktreeRoot: '/repo', buildEnv: {}, region: 'global',
      branch: 'test', commit: 'test', sourceIdentity: 'test@123',
      loginScenario: 'providers:email-only', envFingerprint: 'fixture',
    });
    if (occupied) {
      await expect(execution).rejects.toThrow('exit:1');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('8082 is already in use'));
      expect(spawn).not.toHaveBeenCalled();
      expect(writeMetroOwner).not.toHaveBeenCalled();
      expect(clearMetroOwner).not.toHaveBeenCalled();
    } else {
      await execution;
      expect(spawn).toHaveBeenCalledOnce();
      expect(writeMetroOwner).toHaveBeenCalledWith(8082, expect.objectContaining({ pid: 4242 }));
      for (const callback of exitCallbacks) callback();
      expect(clearMetroOwner).toHaveBeenCalledWith(8082, 4242);
    }
    expect(portInUse).toHaveBeenCalledWith(8082);
  });

  it('waits for the plain-text preview in both file-browser flows', () => {
    for (const name of ['file_browser.yaml', 'visual_files.yaml']) {
      const flow = readFileSync(resolve(process.cwd(), 'e2e/maestro', name), 'utf8').replace(/\r\n/g, '\n');
      expect(flow).toContain('id: "files.row.about.txt"');
      expect(flow).toMatch(/- extendedWaitUntil:\s+visible:\s+id: "filePreview.sourceReady"\s+timeout: 10000/);
      expect(flow).not.toContain('filePreview.markdownRendered');
      // The app defaults to a grid; select list view before looking for rows.
      const listView = flow.indexOf('id: "files.menu.view.list"');
      expect(listView).toBeGreaterThan(flow.indexOf('id: "files.titleMenuButton"'));
      expect(listView).toBeLessThan(flow.indexOf('id: "files.row.about.txt"'));
    }
  });

  it('captures file screenshots only after listing and preview readiness', () => {
    const flow = readFileSync(resolve(process.cwd(), 'e2e/maestro/visual_files.yaml'), 'utf8').replace(/\r\n/g, '\n');
    const listReady = flow.search(/- extendedWaitUntil:\s+visible:\s+id: "files.row.about.txt"/);
    const previewReady = flow.search(/- extendedWaitUntil:\s+visible:\s+id: "filePreview.sourceReady"/);
    expect(listReady).toBeGreaterThanOrEqual(0);
    expect(listReady).toBeLessThan(flow.indexOf('path: visual-files\n'));
    expect(previewReady).toBeGreaterThanOrEqual(0);
    expect(previewReady).toBeLessThan(flow.indexOf('path: visual-files-preview'));
  });

  it('opens usage details from inside the visible menu modal', () => {
    const flow = readFileSync(resolve(process.cwd(), 'e2e/maestro/visual_session_controls_usage.yaml'), 'utf8');
    expect(flow).toContain('id: "session.menuUsageRow"');
    expect(flow.indexOf('id: "session.menuUsageRow"')).toBeGreaterThan(flow.indexOf('id: "session.menuSheet"'));
    expect(flow).not.toContain('id: "session.usageButton"');
  });

  it('opens the Expo target route before shared flows while cleaning native stale overlays', () => {
    const loginFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/login_mock_no_clear.yaml'), 'utf8');
    const loginLaunchFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/login_mock.yaml'), 'utf8');
    const openSessionFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/open_session.yaml'), 'utf8');
    const openSessionNoLaunchFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/open_session_no_launch.yaml'), 'utf8');
    const messageSelectionFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/message_selection.yaml'), 'utf8');
    const filePreviewFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/file_preview.yaml'), 'utf8');
    const visualOfflineFlow = readFileSync(resolve(process.cwd(), 'e2e/maestro/visual_session_offline.yaml'), 'utf8');

    expect(loginFlow).toContain('id: "devices.screen"');
    expect(loginFlow).toContain('id: "session.backButton"');
    expect(loginFlow).toContain('text: "^允许$"');
    expect(loginFlow).not.toContain('text: "Continue"');
    expect(loginFlow).not.toContain('text: "Close"');
    expect(loginLaunchFlow).not.toContain('openLink');
    expect(loginLaunchFlow).toContain('- runFlow: login_mock_no_clear.yaml');
    for (const flow of [openSessionFlow, openSessionNoLaunchFlow]) {
      expect(flow).toContain('id: "connection.syncButton"');
      expect(flow).toContain('optional: true');
      expect(flow).toContain('Sync devices when the connection row is visible');
    }
    expect(openSessionFlow).toContain('Open the recent Expo Go XDMaker project if launchApp lands on Expo Home');
    expect(openSessionFlow).toContain('text: "XDMaker"');
    expect(openSessionFlow).toContain('waitForAnimationToEnd');
    expect(loginFlow).toContain('waitForAnimationToEnd');
    expect(messageSelectionFlow).toContain('- runFlow: open_session_no_launch.yaml');
    expect(messageSelectionFlow).not.toContain('- runFlow: open_session.yaml');
    expect(filePreviewFlow).toContain('- runFlow: open_session_no_launch.yaml');
    expect(filePreviewFlow).not.toContain('- runFlow: open_session.yaml');
    expect(visualOfflineFlow).toContain('id: "session.composerInput"');
    expect(visualOfflineFlow).toContain('- eraseText');
    expect(visualOfflineFlow).toContain('- inputText: "Offline visual draft"');
    expect(visualOfflineFlow).toContain('- hideKeyboard');
    expect(visualOfflineFlow).toContain('id: "session.sendButton"');
    expect(visualOfflineFlow).toContain('id: "pendingSend.badge.uploading"');
    expect(visualOfflineFlow).toContain('- assertNotVisible:');
    expect(visualOfflineFlow).toContain('id: "connection.syncButton"');
    expect(visualOfflineFlow).not.toContain('session.collaborationReadOnlyComposer');
  });

  it('keeps the reconnect entry usable without the removed server and auth APIs', () => {
    const script = 'scripts/device-link-reconnect-smoke.mjs';
    const packageJson = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    expect(packageJson).toContain('"test:e2e:reconnect:local": "node scripts/device-link-reconnect-smoke.mjs --start-server"');
    const result = spawnSync(process.execPath, [script, '--start-server', '--dry-run'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('formal DeviceLinkClient');
    expect(result.stdout).toContain('loopback WebSocket contract fixture');

    const missingCredentials = spawnSync(process.execPath, [script, '--interop'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env,
        CINDY_TEST_RELAY_URL: '',
        CINDY_TEST_HOST_TOKEN: '',
        CINDY_TEST_CONTROLLER_TOKEN: '',
      },
    });
    expect(missingCredentials.status).toBe(2);
    expect(missingCredentials.stderr).toContain('isolated test environment');
  });

  it.each([true, false])('probes Java only for real Maestro runs (dryRun=%s)', (dryRun) => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/maestro-e2e.mjs'), 'utf8');
    const start = source.indexOf('const options = parseArgs(');
    if (start < 0) throw new Error('script workflow entry missing');
    const resolveJavaRuntimeEnv = vi.fn(() => { throw new Error('java-probe'); });
    const probeMetroOwnership = vi.fn();
    const spawn = vi.fn();
    const log = vi.fn();
    const execute = () => runInNewContext(source.slice(start), {
      resolve, existsSync: () => true, readFileSync: () => 'appId: test',
      resolveJavaRuntimeEnv, probeMetroOwnership, spawnSync: spawn,
      resolveMobileE2eProfile: () => undefined,
      mobileRoot: '/mobile', flowRoot: '/mobile/flows', doctorScript: '/mobile/doctor.mjs',
      defaultAppId: 'com.xd.cindy', loginScenario: 'providers:email-only',
      console: { log },
      process: {
        argv: ['node', 'maestro-e2e.mjs', ...(dryRun ? ['--dry-run'] : [])],
        env: {}, exit: (code: number) => { throw new Error('exit:' + code); },
      },
    });
    expect(execute).toThrow(dryRun ? 'exit:0' : 'java-probe');
    expect(resolveJavaRuntimeEnv).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    expect(probeMetroOwnership).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    if (dryRun) expect(log).toHaveBeenCalledWith('maestro dry run: APP_ID=com.xd.cindy');
  });

  it('keeps Maestro dry runs independent of Metro ownership', () => {
    const script = resolve(process.cwd(), 'scripts/maestro-e2e.mjs');
    const result = spawnSync(process.execPath, [script, '--dry-run', '--flow', 'login_mock_no_clear.yaml'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, EXPO_PUBLIC_LOGIN_SCENARIO: '' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('maestro dry run: APP_ID=');
    expect(result.stderr).not.toContain('Active Metro');
  });
});

// These execute existing developer entry points; the old shape-only checks could pass
// while process environments, deferred switching, or recovery ownership were broken.
function scriptBody(file: string, entry: string) {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  const start = source.indexOf(entry);
  if (start < 0) throw new Error(`missing workflow entry: ${file}`);
  return source.slice(start);
}

const maestroBody = scriptBody('scripts/maestro-e2e.mjs', 'const options = parseArgs(');
const mockHostAst = ts.createSourceFile('mock-host.mjs', readFileSync(resolve(process.cwd(), 'scripts/mock-device-link-host.mjs'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const mockHostFunctions = mockHostAst.statements.filter((node) => ts.isFunctionDeclaration(node) && !['broadcast', 'push', 'send'].includes(node.name?.text ?? '')).map((node) => node.getText(mockHostAst)).join(String.fromCharCode(10));
const mockBranches = mockHostAst.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === 'MOCK_WORKTREE_BRANCHES'))?.getText(mockHostAst);
if (!mockBranches) throw new Error('mock-host branch fixture missing');

function mockHost(platform: 'darwin' | 'win32' = 'darwin') {
  const state = {
    sessions: [{ id: 'session', agentKind: 'cc', model: 'old', workingDir: '/repo' }],
    messages: new Map(), projections: new Map(),
  };
  const send = vi.fn();
  const context = {
    state, sessionId: 'session', path: posix, revokedControllers: new Set(),
    broadcast: send, push: send, send, debug: false, console,
    process: { platform, env: { HOME: '/fixture-home', APPDATA: '/fixture-appdata' } },
    fs: { readdirSync: () => ['xdt-maker-test.db', 'unrelated.txt'], statSync: () => ({ mtimeMs: 1 }) },
  };
  return runInNewContext(`${mockBranches}
${mockHostFunctions}
const mockWorktree = createMockWorktreeState(state);
({ invoke: (channel, args) => handleInvoke(null, channel, args), state, listRealDbCandidates, resolveRealDbPath });`, context) as {
    invoke: (channel: string, args: unknown[]) => Promise<any>;
    state: typeof state; listRealDbCandidates: () => string[]; resolveRealDbPath: (path: string, Database: unknown) => string;
  };
}

describe('native e2e developer workflows', () => {
  it.each(['com.xd.cindy', 'host.exp.Exponent'])('passes Java env to doctor and Maestro after opening %s', (appId) => {
    const spawn = vi.fn((_command: string, _args: string[], _options: object) => ({ status: 0, stdout: '', stderr: '' }));
    const toolEnv = { JAVA_HOME: '/jdk17', PATH: '/jdk17/bin:/tools' };
    runInNewContext(maestroBody, {
      resolve: posix.resolve, existsSync: () => true, readFileSync: () => 'appId: test',
      resolveJavaRuntimeEnv: () => toolEnv, probeMetroOwnership: vi.fn(), spawnSync: spawn,
      resolveMobileE2eProfile: () => undefined, mobileRoot: '/mobile', flowRoot: '/mobile/flows',
      doctorScript: '/mobile/doctor.mjs', defaultAppId: 'com.xd.cindy', loginScenario: 'providers:email-only',
      console: { log: vi.fn() }, URL,
      process: {
        argv: ['node', 'maestro-e2e.mjs', '--platform', 'ios', '--app-id', appId],
        execPath: '/node', platform: 'darwin', env: { XDT_MOBILE_E2E_EXPO_LAUNCH_DELAY_MS: '0' },
        exit: (code: number) => { throw new Error(`exit:${code}`); },
      },
    });
    expect(spawn).toHaveBeenCalledWith('/node', expect.arrayContaining(['/mobile/doctor.mjs', '--require-maestro', '--platform', 'ios', '--app-id', appId]), { cwd: '/mobile', env: toolEnv, stdio: 'inherit' });
    expect(spawn).toHaveBeenLastCalledWith('maestro', expect.arrayContaining(['test', `APP_ID=${appId}`, `CLEAR_STATE=${appId === 'host.exp.Exponent' ? 'false' : 'true'}`]), expect.objectContaining({ env: expect.objectContaining({ ...toolEnv, MAESTRO_DRIVER_STARTUP_TIMEOUT: '120000' }) }));
    const commands = spawn.mock.calls.map(([command, args]) => `${command} ${args.join(' ')}`);
    const terminate = commands.findIndex((cmd) => cmd.includes(`terminate booted ${appId}`));
    const launch = commands.findIndex((cmd) => cmd.includes(appId === 'host.exp.Exponent' ? 'openurl booted exp://localhost:8081/--/devices' : `launch booted ${appId}`));
    expect(terminate).toBeGreaterThanOrEqual(0);
    expect(launch).toBeGreaterThan(terminate);
    expect(launch).toBeLessThan(commands.length - 1);
  });

  it('plans local Expo, mock host, real-db, and optional cloud preflight without starting them', () => {
    const result = spawnSync(process.execPath, ['scripts/local-device-link-smoke.mjs', '--dry-run', '--start-server', '--start-expo', '--mock-host', '--mock-host-real-db', 'auto', '--voice-cloud-preflight', '--voice-cloud-all-candidates', '--profile', 'ios-iphone-17-pro-expo-go'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, EXPO_PUBLIC_LOGIN_SCENARIO: 'providers:email-only' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('- start expo: yes');
    expect(result.stdout).toContain('- mock host real db: auto');
    expect(result.stdout).toContain('- voice cloud candidates: all ASR/refine provider candidates');
    expect(result.stdout).toContain('- expo login scenario: providers:email-only');
  });

  it.each(['darwin', 'win32'] as const)('discovers local SQLite candidates read-only for %s', (platform) => {
    const host = mockHost(platform);
    const candidates = host.listRealDbCandidates();
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toBe(`${platform === 'darwin' ? '/fixture-home/Library/Application Support' : '/fixture-appdata'}/xdt-maker/xdt-maker-test.db`);
    const close = vi.fn();
    const Database = vi.fn(function (_path: string, options: object) {
      expect(options).toEqual({ readonly: true, fileMustExist: true });
      return { pragma: vi.fn(), prepare: () => ({ get: () => ({ count: 1 }) }), close };
    });
    expect(host.resolveRealDbPath('auto', Database)).toBe(candidates[0]);
    expect(Database).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('applies a deferred Agent switch only when the next queued message is accepted', async () => {
    const host = mockHost();
    expect(await host.invoke('maker:get-capabilities', ['codex'])).toMatchObject({ supportsSessionAgentSwitch: true });
    expect(await host.invoke('maker:provider:list', [])).toMatchObject({ providers: expect.arrayContaining([expect.objectContaining({ agents: ['codex'] })]) });
    expect(await host.invoke('maker:switch-session-agent', ['session', 'codex', 'next-model'])).toMatchObject({ deferred: true });
    expect(host.state.sessions[0].agentKind).toBe('cc');
    expect(await host.invoke('maker:get-session-agent-switch-intent', ['session'])).toMatchObject({ targetAgentKind: 'codex' });
    await host.invoke('maker:input:enqueue', ['session', { text: 'next message' }]);
    expect(host.state.sessions[0]).toMatchObject({ agentKind: 'codex', model: 'next-model' });
    expect(await host.invoke('maker:get-session-agent-switch-intent', ['session'])).toBeNull();
    expect(host.state.messages.get('session')[0]).toMatchObject({ role: 'user', content: 'next message' });
  });

  it('preserves recovery-key ownership before and after a mock session claims its worktree', async () => {
    const host = mockHost();
    await host.invoke('maker:apply-new-maker-worktree-pref', [{ worktreeEnabled: true }]);
    expect(await host.invoke('maker:get-new-maker-defaults', [])).toEqual({ worktreeEnabled: true });
    expect(await host.invoke('worktree:detect-cwd', [{ cwd: '/repo' }])).toMatchObject({ supportsRecoveryKeyDiscard: true, repoRoot: '/repo' });
    const branches = await host.invoke('worktree:list-branches', [{ baseRepo: '/repo' }]);
    const { name } = await host.invoke('worktree:suggest-name', [{ baseRepo: '/repo' }]);
    const request = { sessionId: 'created', baseRepo: '/repo', name, sourceBranch: branches.branches[1], recoveryKey: 'fixture-recovery-key' };
    const result = await host.invoke('worktree:create', [request]);
    expect(result).toMatchObject({ ok: true, meta: { path: `/repo/.cindy-worktrees/${name}`, branch: `xdt/${name}`, sourceBranch: branches.branches[1] } });
    await expect(host.invoke('worktree:discard-precreated', [{ sessionId: 'created', recoveryKey: 'wrong-key' }])).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await host.invoke('worktree:discard-precreated', [{ sessionId: 'created', recoveryKey: request.recoveryKey }])).toEqual({ discarded: true, branchDeleted: true });
    await host.invoke('worktree:create', [request]);
    await host.invoke('maker:create-session', [{ id: 'created', workingDir: result.meta.path }]);
    expect(host.state.sessions[0]).toMatchObject({ worktreePath: result.meta.path });
    await expect(host.invoke('worktree:discard-precreated', [{ sessionId: 'created', recoveryKey: request.recoveryKey }])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects retired credential sync with its explicit compatibility error', async () => {
    const host = mockHost();
    await expect(host.invoke('device-link:voice:credential-sync', [])).rejects.toMatchObject({ code: 'VOICE_CREDENTIAL_SYNC_REMOVED' });
    expect(await host.invoke('device-link:voice:dictionary-learning', [])).toMatchObject({ ok: true, ignoreReason: 'mock-host' });
  });

  it.each(['safe controller', 'transcribeVoice(', 'DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL', 'device-link:voice:transcribe'])('runs the mobile scope gate against %s', (fixture) => {
    const error = vi.fn();
    const execute = () => runInNewContext(scriptBody('scripts/mobile-scope-guard.mjs', 'const forbiddenFiles ='), {
      mobileRoot: '/mobile', resolve: posix.resolve, join: posix.join, relative: posix.relative, basename: posix.basename,
      existsSync: (path: string) => ['/mobile/app', '/mobile/app/composer.tsx'].includes(path),
      statSync: (path: string) => ({ isFile: () => path.endsWith('.tsx'), isDirectory: () => path === '/mobile/app' }),
      readdirSync: () => ['composer.tsx'], readFileSync: () => fixture,
      console: { log: vi.fn(), error }, process: { exit: (code: number) => { throw new Error(`exit:${code}`); } },
    });
    if (fixture === 'safe controller') { execute(); expect(error).not.toHaveBeenCalled(); }
    else { expect(execute).toThrow('exit:1'); expect(error).toHaveBeenCalledWith(expect.stringContaining('Mobile voice composer must use the realtime controller')); }
  });
});
