import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { atomicPrivateWrite, privateDirectory, readPrivateFile, windowsPowerShellEnv, windowsSystemCommand } from './platform.js';
import { validateHostCommand, type TerminalHostCommand } from './host-command.js';

const execute = promisify(execFile);
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[char]!);
// Task Scheduler imports its XML as UTF-16. A BOM also lets PowerShell's
// ReadAllText decode the same descriptor when switching to boot startup.
const scheduledTaskXml = (value: string) => Buffer.from('\ufeff' + value.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le');
const readScheduledTaskXml = (value: Buffer) => value[0] === 0xff && value[1] === 0xfe ? value.subarray(2).toString('utf16le') : value.toString('utf8');
const windowsArg = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
const systemdEnvironment = (key: string, value: string) => `"${key}=${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const systemdArg = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
// WorkingDirectory is a path setting, not an ExecStart argument: systemd
// treats quotes literally. The final /. also protects trailing whitespace or
// backslashes from unit-file trimming/line continuation without changing cwd.
const systemdDirectory = (value: string) => `${value.replace(/%/g, '%%')}/.`;
export type Installation = { version: 1; platform: string; id: string; file: string; starts: 'login' | 'boot'; activeAfter: 'next-login' | 'next-boot'; scope?: 'user' | 'system'; registrationOnly?: true; uninstalling?: boolean; desktop?: true };
export interface ServiceInspection {
  installation: Installation | null;
  managerAvailable: boolean;
  registered: boolean;
  running: boolean;
  pid?: number;
  starts?: 'login' | 'boot';
  bootEnableCommand?: string[];
}
export interface ServiceRemoval { removed: boolean; requiresLocalCompletion?: boolean }
type ServiceExecutor = (file: string, args: string[], options: { timeout: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
export interface ServiceEnvironment { platform?: NodeJS.Platform; home?: string; uid?: number; userName?: string; env?: NodeJS.ProcessEnv; execute?: ServiceExecutor; interactive?: (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<void>; desktopHost?: TerminalHostCommand }

/** User-scoped registration never captures a token, password or login shell. */
export class TerminalServiceManager {
  readonly id: string;
  private metadata: string;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly uid: number | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly execute: ServiceExecutor;
  private readonly userName: string;
  private readonly interactive: NonNullable<ServiceEnvironment['interactive']>;
  private readonly desktopHost: TerminalHostCommand | undefined;
  constructor(readonly profileDir: string, readonly entry: string, readonly node = process.execPath, runtime: ServiceEnvironment = {}) {
    this.platform = runtime.platform ?? process.platform;
    this.desktopHost = runtime.desktopHost ? validateHostCommand(runtime.desktopHost) : undefined;
    this.home = runtime.home ?? os.userInfo().homedir;
    this.uid = runtime.uid ?? process.getuid?.();
    this.env = runtime.env ?? process.env;
    this.execute = runtime.execute ?? execute;
    this.userName = runtime.userName ?? os.userInfo().username;
    this.interactive = runtime.interactive ?? ((file, args, env) => new Promise((resolve, reject) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) { reject(new Error('SERVICE_BOOT_REQUIRES_INTERACTIVE_TERMINAL')); return; }
      const child = spawn(file, args, { env: env ?? this.env, stdio: 'inherit', shell: false });
      child.once('error', () => reject(new Error('SERVICE_BOOT_SETUP_FAILED')));
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('SERVICE_BOOT_SETUP_FAILED')));
    }));
    if (![profileDir, entry, node].every(value => path.isAbsolute(value) && !/[\r\n\0]/.test(value))) throw new Error('INVALID_SERVICE_PATH');
    this.id = `app.cindy.terminal.${createHash('sha256').update(profileDir).digest('hex').slice(0, 16)}`;
    this.metadata = path.join(profileDir, 'service-installation.json');
  }
  async status(): Promise<Installation | null> {
    const raw = await readPrivateFile(this.metadata);
    if (!raw) return null;
    const data = JSON.parse(raw.toString()) as Installation;
    if (data.version !== 1 || data.id !== this.id || data.platform !== this.platform) throw new Error('SERVICE_INSTALLATION_INVALID');
    return data;
  }
  async install(): Promise<Installation> {
    await privateDirectory(this.profileDir);
    const current = await this.status();
    if (current?.scope === 'system') {
      if (this.desktopHost) throw new Error('DESKTOP_SERVICE_REQUIRES_LOGIN');
      return current;
    }
    const executable = this.desktopHost?.executable ?? this.node;
    const args = [...(this.desktopHost?.args ?? [this.entry, 'serve']), '--state-dir', this.profileDir];
    let file: string;
    let starts: Installation['starts'] = 'login';
    if (this.platform === 'darwin') {
      file = path.join(this.home, 'Library', 'LaunchAgents', `${this.id}.plist`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const log = path.join(this.profileDir, 'service.log');
      await atomicPrivateWrite(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${this.id}</string><key>ProgramArguments</key><array>${[executable, ...args].map(value=>`<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>WorkingDirectory</key><string>${xml(this.profileDir)}</string><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`);
      await this.execute('plutil', ['-lint', file], { timeout: 10_000 });
      const location = await this.launchdLocation();
      await this.execute('launchctl', ['enable', location.target], { timeout: 10_000 });
    } else if (this.platform === 'linux') {
      const config = this.env.XDG_CONFIG_HOME || path.join(this.home, '.config');
      if (!path.isAbsolute(config) || /[\r\n\0]/.test(config)) throw new Error('INVALID_CONFIG_HOME');
      file = path.join(config, 'systemd', 'user', `${this.id}.service`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await atomicPrivateWrite(file, `[Unit]\nDescription=Cindy terminal host\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${[executable,...args].map(systemdArg).join(' ')}\nWorkingDirectory=${systemdDirectory(this.profileDir)}\nEnvironment=${systemdEnvironment('HOME',this.home)} ${systemdEnvironment('XDG_CONFIG_HOME',config)} ${systemdEnvironment('XDG_RUNTIME_DIR',`/run/user/${this.userId()}`)}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=45\nUMask=0077\n\n[Install]\nWantedBy=${this.desktopHost?'graphical-session.target':'default.target'}\n`);
      try {
        await this.userSystemctl(['daemon-reload']);
        await this.userSystemctl(['enable', `${this.id}.service`]);
      } catch { throw new Error('USER_SERVICE_MANAGER_UNAVAILABLE'); }
      try {
        const { stdout } = await this.execute('loginctl', ['show-user', String(this.uid), '-p', 'Linger', '--value'], { timeout: 10_000 });
        if (stdout.trim() === 'yes' && !this.desktopHost) starts = 'boot';
      } catch { /* The descriptor remains valid for the next user login. */ }
    } else if (this.platform === 'win32') {
      file = path.join(this.profileDir, 'scheduled-service.xml');
      const { stdout } = await this.execute(windowsSystemCommand('whoami',this.env), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10_000 });
      const sid = stdout.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) throw new Error('SERVICE_USER_UNAVAILABLE');
      const supervisedArgs = [path.join(path.dirname(this.entry), 'service-supervisor.cjs'), this.entry, this.profileDir];
      if(this.desktopHost)supervisedArgs.push(JSON.stringify({executable,args}));
      await atomicPrivateWrite(file, scheduledTaskXml(`<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Cindy terminal host</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers><Principals><Principal id="Cindy"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Cindy"><Exec><Command>${xml(this.node)}</Command><Arguments>${xml(supervisedArgs.map(windowsArg).join(' '))}</Arguments><WorkingDirectory>${xml(this.profileDir)}</WorkingDirectory></Exec></Actions></Task>\n`));
      try { await this.execute(windowsSystemCommand('schtasks',this.env), ['/Create', '/TN', this.id, '/XML', file, '/F'], { windowsHide: true, timeout: 15_000 }); }
      catch (cause) { throw new Error('SERVICE_REGISTRATION_FAILED', { cause }); }
    } else throw new Error('PLATFORM_NOT_SUPPORTED');
    const installation: Installation = { version: 1, platform: this.platform, id: this.id, file, starts, activeAfter: starts === 'boot' ? 'next-boot' : 'next-login', registrationOnly: true, ...(this.desktopHost?{desktop:true as const}:{}) };
    await atomicPrivateWrite(this.metadata, JSON.stringify(installation));
    return installation;
  }

  /** Read the operating system, not just the saved registration receipt. */
  async inspect(): Promise<ServiceInspection> {
    const installation = await this.status();
    const result: ServiceInspection = { installation, managerAvailable: false, registered: false, running: false };
    if (!installation) return result;
    try {
      if (this.platform === 'linux') {
        const { stdout } = await this.userSystemctl(['show', `${this.id}.service`, '--property=LoadState,ActiveState,MainPID']);
        const fields = Object.fromEntries(stdout.trim().split(/\r?\n/).map(line => line.split(/=(.*)/s).slice(0, 2)));
        result.managerAvailable = true;
        result.registered = fields.LoadState === 'loaded';
        result.running = fields.ActiveState === 'active';
        const pid = Number(fields.MainPID);
        if (Number.isSafeInteger(pid) && pid > 0) result.pid = pid;
        result.starts = !installation.desktop && await this.lingers() ? 'boot' : 'login';
        if (result.starts === 'login') result.bootEnableCommand = ['loginctl', 'enable-linger', this.userId()];
      } else if (this.platform === 'darwin') {
        const location = await this.launchdLocation(installation.scope);
        result.managerAvailable = true;
        result.registered = location.output !== undefined;
        result.running = /\bstate = running\b/.test(location.output ?? '');
        const pid = Number(location.output?.match(/\bpid = (\d+)/)?.[1]);
        if (Number.isSafeInteger(pid) && pid > 0) result.pid = pid;
        result.starts = installation.scope === 'system' ? 'boot' : 'login';
      } else if (this.platform === 'win32') {
        // The COM state enum is locale-independent (4 = running). No password,
        // interactive PowerShell profile or command-shell interpolation.
        const script = `$s=[Activator]::CreateInstance([type]::GetTypeFromProgID('Schedule.Service'));$s.Connect();$t=$s.GetFolder('\\').GetTask('${this.id}');[Console]::Write([int]$t.State)`;
        const { stdout } = await this.execute(windowsSystemCommand('powershell',this.env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15_000, windowsHide: true, env: windowsPowerShellEnv(this.env) });
        result.managerAvailable = result.registered = true;
        result.running = stdout.trim() === '4';
        result.starts = installation.starts;
      }
    } catch { /* A receipt alone never proves an available or running manager. */ }
    return result;
  }

  /** Explicit Linux boot opt-in. logind performs its normal policy check; the
   * caller can run bootEnableCommand itself if administrator approval is needed. */
  async enableBoot(): Promise<ServiceInspection> {
    let installation = await this.status();
    if(this.desktopHost || installation?.desktop)throw new Error('DESKTOP_SERVICE_REQUIRES_LOGIN');
    if (this.platform === 'darwin' || this.platform === 'win32') {
      if (!installation) installation = await this.install();
      return this.enableNativeBoot(installation);
    }
    if (this.platform !== 'linux') throw new Error('BOOT_SERVICE_NOT_SUPPORTED');
    await this.execute('loginctl', ['enable-linger', this.userId()], { timeout: 15_000 });
    if (!await this.lingers()) throw new Error('SERVICE_LINGER_NOT_ENABLED');
    // Linger starts the user manager even on a machine with no login session.
    if (!installation) installation = await this.install();
    await atomicPrivateWrite(this.metadata, JSON.stringify({ ...installation, starts: 'boot', activeAfter: 'next-boot' }));
    return this.inspect();
  }

  /** Foreground only. The OS owns credential prompting/storage; no password is
   * returned through Cindy RPC, arguments, logs, or the profile. */
  private async enableNativeBoot(installation: Installation): Promise<ServiceInspection> {
    if (installation.scope === 'system' && installation.starts === 'boot') return this.inspect();
    if (!this.userName || /[\r\n\0]/.test(this.userName)) throw new Error('SERVICE_USER_UNAVAILABLE');
    if (this.platform === 'darwin') {
      if (this.uid === 0) throw new Error('SERVICE_BOOT_REQUIRES_USER_ACCOUNT');
      const target = `/Library/LaunchDaemons/${this.id}.plist`;
      const temporary = path.join(this.profileDir, 'boot-service.plist');
      const args = [this.node, this.entry, 'serve', '--state-dir', this.profileDir];
      await atomicPrivateWrite(temporary, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${this.id}</string><key>UserName</key><string>${xml(this.userName)}</string><key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(this.home)}</string><key>USER</key><string>${xml(this.userName)}</string><key>LOGNAME</key><string>${xml(this.userName)}</string></dict><key>WorkingDirectory</key><string>${xml(this.profileDir)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`);
      const previous = await this.inspect();
      const previousLocation = await this.launchdLocation();
      let copied = false;
      let userDisabled = false;
      let systemStarted = false;
      let committed = false;
      try {
        await this.execute('plutil', ['-lint', temporary], { timeout: 10_000 });
        await this.interactive('/usr/bin/sudo', ['/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '644', temporary, target]);
        copied = true;
        await this.execute('launchctl', ['disable', previousLocation.target], { timeout: 10_000 });
        userDisabled = true;
        if (previous.registered) await this.execute('launchctl', ['bootout', previousLocation.target], { timeout: 15_000 });
        await this.interactive('/usr/bin/sudo', ['/bin/launchctl', 'enable', `system/${this.id}`]);
        await this.interactive('/usr/bin/sudo', ['/bin/launchctl', 'bootstrap', 'system', target]);
        systemStarted = true;
        await atomicPrivateWrite(this.metadata, JSON.stringify({ ...installation, scope: 'system', file: target, starts: 'boot', activeAfter: 'next-boot', registrationOnly: true }));
        committed = true;
        // The user descriptor is disabled and is no longer authoritative.
        await fs.rm(installation.file, { force: true }).catch(() => {});
      } catch (error) {
        if (!committed && copied) {
          try {
            if (systemStarted) await this.interactive('/usr/bin/sudo', ['/bin/launchctl', 'bootout', `system/${this.id}`]);
            await this.interactive('/usr/bin/sudo', ['/bin/rm', '-f', target]);
            if (userDisabled) {
              await this.execute('launchctl', ['enable', previousLocation.target], { timeout: 10_000 });
              if (previous.registered && !(await this.inspect()).registered) {
                await this.execute('launchctl', ['bootstrap', previousLocation.domain, installation.file], { timeout: 15_000 });
              }
            }
          } catch (rollbackError) {
            throw new Error('SERVICE_BOOT_ROLLBACK_REQUIRED', { cause: rollbackError });
          }
        }
        throw error;
      } finally { await fs.rm(temporary, { force: true }); }
    } else {
      const { stdout } = await this.execute(windowsSystemCommand('whoami',this.env), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10_000 });
      const sid = stdout.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) throw new Error('SERVICE_USER_UNAVAILABLE');
      const xmlText = readScheduledTaskXml(await fs.readFile(installation.file));
      const bootXml = xmlText.replace(/<LogonTrigger>[\s\S]*?<\/LogonTrigger>/, '<BootTrigger><Enabled>true</Enabled></BootTrigger>').replace('<LogonType>InteractiveToken</LogonType>', '<LogonType>Password</LogonType>');
      if (bootXml === xmlText || !bootXml.includes('<LogonType>Password</LogonType>')) throw new Error('SERVICE_INSTALLATION_INVALID');
      const temporary = path.join(this.profileDir, 'boot-service.xml');
      await atomicPrivateWrite(temporary, scheduledTaskXml(bootXml));
      const user = await this.execute(windowsSystemCommand('whoami',this.env), [], { windowsHide: true, timeout: 10_000 });
      if (!user.stdout.trim() || /[\r\n\0]/.test(user.stdout.trim())) throw new Error('SERVICE_USER_UNAVAILABLE');
      const script = `$ErrorActionPreference='Stop';$secure=Read-Host 'Windows account password' -AsSecureString;$pointer=[IntPtr]::Zero;try{$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);$password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer);Register-ScheduledTask -TaskName $env:CINDY_BOOT_TASK -Xml ([IO.File]::ReadAllText($env:CINDY_BOOT_XML)) -User $env:CINDY_BOOT_USER -Password $password -Force | Out-Null}finally{if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)};$password=$null;$secure.Dispose()}`;
      try {
        await this.interactive(windowsSystemCommand('powershell',this.env), ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { ...windowsPowerShellEnv(this.env), CINDY_BOOT_XML: temporary, CINDY_BOOT_TASK: this.id, CINDY_BOOT_USER: user.stdout.trim() });
        await atomicPrivateWrite(installation.file, scheduledTaskXml(bootXml));
        await atomicPrivateWrite(this.metadata, JSON.stringify({ ...installation, scope: 'system', starts: 'boot', activeAfter: 'next-boot', registrationOnly: true }));
      } finally { await fs.rm(temporary, { force: true }); }
    }
    return this.inspect();
  }

  /** Foreground caller only, after stopping and disconnecting any manually
   * started host. Registration does not silently replace the current process. */
  async activate(): Promise<ServiceInspection> {
    const installation = await this.status();
    if (!installation || installation.uninstalling) throw new Error('SERVICE_NOT_INSTALLED');
    if (this.platform === 'linux') {
      await this.userSystemctl(['start', `${this.id}.service`], 30_000);
    } else if (this.platform === 'darwin') {
      const location = await this.launchdLocation(installation.scope);
      if (installation.scope === 'system') {
        if (location.output === undefined) await this.interactive('/usr/bin/sudo', ['/bin/launchctl', 'bootstrap', 'system', installation.file]);
        await this.interactive('/usr/bin/sudo', ['/bin/launchctl', 'kickstart', location.target]);
      } else {
        if (location.output === undefined) await this.execute('launchctl', ['bootstrap', location.domain, installation.file], { timeout: 15_000 });
        await this.execute('launchctl', ['kickstart', location.target], { timeout: 15_000 });
      }
    } else if (this.platform === 'win32') {
      await this.execute(windowsSystemCommand('schtasks',this.env), ['/Run', '/TN', this.id], { timeout: 15_000, windowsHide: true });
    } else throw new Error('PLATFORM_NOT_SUPPORTED');
    return this.inspect();
  }

  private userId(): string {
    if (this.uid === undefined || !Number.isSafeInteger(this.uid) || this.uid < 0) throw new Error('SERVICE_USER_UNAVAILABLE');
    return String(this.uid);
  }

  /** Foreground recovery when there is no host IPC (for example during a
   * Windows crash backoff). Normal stop still lets the host finish its work. */
  async stopIdleSupervisor(): Promise<void> {
    if (this.platform !== 'win32' || !(await this.status())) return;
    if ((await this.inspect()).running) {
      await this.execute(windowsSystemCommand('schtasks',this.env), ['/End', '/TN', this.id], { timeout: 15_000, windowsHide: true });
    }
  }

  private async lingers(): Promise<boolean> {
    try {
      const { stdout } = await this.execute('loginctl', ['show-user', this.userId(), '-p', 'Linger', '--value'], { timeout: 10_000 });
      return stdout.trim() === 'yes';
    } catch { return false; }
  }

  private userSystemctl(args: string[], timeout = 10_000) {
    // A service or sudo session may inherit another account's runtime path.
    // Always address the current Unix account's systemd manager; desktop
    // session buses and caller-supplied bus overrides are not its identity.
    const runtime = `/run/user/${this.userId()}`;
    const env: NodeJS.ProcessEnv = { ...this.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
    delete env.SYSTEMD_BUS_ADDRESS;
    return this.execute('systemctl', ['--user', ...args], { timeout, env });
  }
  async uninstall(): Promise<ServiceRemoval> {
    const current = await this.status();
    if (!current) return { removed: false };
    if (this.platform === 'darwin' && current.scope === 'system') {
      await atomicPrivateWrite(this.metadata, JSON.stringify({ ...current, uninstalling: true }));
      return { removed: false, requiresLocalCompletion: true };
    }
    if (this.platform === 'darwin') {
      // Disable restart before removing the descriptor, but do not kill this
      // process while it is returning an RPC result to the foreground CLI.
      await this.execute('launchctl', ['disable', (await this.launchdLocation()).target], { timeout: 10_000 });
    } else if (this.platform === 'linux') {
      try { await this.userSystemctl(['disable', `${this.id}.service`]); }
      catch { throw new Error('SERVICE_UNREGISTRATION_FAILED'); }
    } else if (this.platform === 'win32') {
      try { await this.execute(windowsSystemCommand('schtasks',this.env), ['/Delete', '/TN', this.id, '/F'], { windowsHide: true, timeout: 15_000 }); }
      catch { throw new Error('SERVICE_UNREGISTRATION_FAILED'); }
    }
    // The installation record is trusted only for its fixed profile-derived path.
    const expected = this.platform === 'darwin'
      ? path.join(this.home, 'Library', 'LaunchAgents', `${this.id}.plist`)
      : this.platform === 'win32' ? path.join(this.profileDir, 'scheduled-service.xml')
      : path.join(this.env.XDG_CONFIG_HOME || path.join(this.home, '.config'), 'systemd', 'user', `${this.id}.service`);
    if (current.file !== expected) throw new Error('SERVICE_INSTALLATION_INVALID');
    await fs.rm(expected, { force: true });
    if (this.platform === 'darwin') {
      await atomicPrivateWrite(this.metadata, JSON.stringify({ ...current, uninstalling: true }));
      return { removed: false, requiresLocalCompletion: true };
    }
    await fs.rm(this.metadata, { force: true });
    if (this.platform === 'linux') await this.userSystemctl(['daemon-reload']);
    return { removed: true };
  }

  private async launchdLocation(scope?: Installation['scope']): Promise<{ domain: string; target: string; output?: string }> {
    const domains = scope === 'system' ? ['system'] : [`gui/${this.userId()}`, `user/${this.userId()}`];
    // A missing job is normal before first activation. Probe the manager
    // separately, and retain an existing background job when a GUI login has
    // since appeared. SSH-only machines have a user domain without a GUI one.
    for (const domain of domains) {
      try {
        const { stdout } = await this.execute('launchctl', ['print', `${domain}/${this.id}`], { timeout: 10_000 });
        return { domain, target: `${domain}/${this.id}`, output: stdout };
      } catch { /* The job may not have been bootstrapped yet. */ }
    }
    for (const domain of domains) {
      try {
        await this.execute('launchctl', ['print', domain], { timeout: 10_000 });
        return { domain, target: `${domain}/${this.id}` };
      } catch { /* Try the non-GUI domain of the same Unix account. */ }
    }
    throw new Error('SERVICE_MANAGER_UNAVAILABLE');
  }

  /** Foreground CLI only, after the uninstall RPC has returned and disconnected.
   * bootout terminates the launched service, including its keep-alive job. */
  async completeUninstall(): Promise<ServiceRemoval> {
    if (this.platform !== 'darwin') return this.uninstall();
    const current = await this.status();
    if (!current) return { removed: false };
    if (!current.uninstalling) throw new Error('SERVICE_UNINSTALL_NOT_PREPARED');
    if (current.scope === 'system') {
      const expected = `/Library/LaunchDaemons/${this.id}.plist`;
      if (current.file !== expected) throw new Error('SERVICE_INSTALLATION_INVALID');
      if ((await this.inspect()).registered) await this.interactive('/usr/bin/sudo', ['/bin/launchctl', 'bootout', `system/${this.id}`]);
      await this.interactive('/usr/bin/sudo', ['/bin/rm', '-f', expected]);
      await fs.rm(this.metadata, { force: true });
      return { removed: true };
    }
    const target = (await this.launchdLocation()).target;
    try { await this.execute('launchctl', ['bootout', target], { timeout: 15_000 }); }
    catch {
      // An ordinary manually started daemon has no launchd job. Only the
      // command's explicit no-service result can count as already unloaded.
      try {
        await this.execute('launchctl', ['print', target], { timeout: 10_000 });
        throw new Error('SERVICE_UNREGISTRATION_FAILED');
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        if (typeof stderr !== 'string' || !/could not find (?:specified )?service/i.test(stderr)) throw new Error('SERVICE_UNREGISTRATION_FAILED');
      }
    }
    await fs.rm(this.metadata, { force: true });
    return { removed: true };
  }
}
