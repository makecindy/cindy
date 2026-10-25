import { terminalNodeExecutable } from '../version.js';
import path from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { privateDirectory } from '../platform.js';
import { HeadlessGhostSandbox } from '@cindy/plugin-runtime/headlessSandbox';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

/** Browser-backed capabilities are lazy. The host and its model runtimes stay
 * usable on a machine where no browser has been installed yet. A system browser
 * gets an ephemeral sandbox context; its personal profile is never opened. */
export class TerminalBrowserRuntime {
  private flight?: Promise<string>;
  private closed = false;
  private readonly abort = new AbortController();
  constructor(private options: {root:string;changed?(status:'installing'|'ready'|'failed'):void}) {}

  resolve(): Promise<string> {
    if (this.closed) return Promise.reject(new Error('BROWSER_RUNTIME_CLOSED'));
    if (!this.flight) {
      const flight = this.prepare();
      this.flight = flight;
      void flight.catch(() => { if (this.flight === flight) this.flight = undefined; });
    }
    return this.flight;
  }

  async installed(): Promise<string|null> {
    if(this.closed)throw new Error('BROWSER_RUNTIME_CLOSED');
    const candidates = process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((value):value is string => !!value).flatMap(root => [path.join(root,'Google/Chrome/Application/chrome.exe'),path.join(root,'Microsoft/Edge/Application/msedge.exe')])
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    for (const candidate of candidates) {
      try { await access(candidate,constants.X_OK); this.abort.signal.throwIfAborted(); return candidate; } catch (error) { if (this.closed) throw error; }
    }
    const directory = path.join(this.options.root,'chromium');
    const env = {...process.env,PLAYWRIGHT_BROWSERS_PATH:directory};
    // Ask the pinned runtime for its platform-specific path instead of copying
    // its private revision/directory naming rules into Cindy.
    const probe = `process.stdout.write(require(${JSON.stringify(require.resolve('playwright-core'))}).chromium.executablePath())`;
    const {stdout} = await execute(terminalNodeExecutable(),['-e',probe],{env,timeout:15_000,windowsHide:true,signal:this.abort.signal});
    const executable = stdout.trim();
    if (!path.isAbsolute(executable) || /[\r\n\0]/.test(executable)) throw new Error('BROWSER_RUNTIME_PATH_INVALID');
    try { await access(executable,constants.X_OK); return executable; } catch { this.abort.signal.throwIfAborted();return null; }
  }

  async check(){
    const executable=await this.installed();
    if(!executable)return {ok:false as const,code:'BROWSER_NOT_INSTALLED'};
    const sandbox=new HeadlessGhostSandbox({executablePath:executable,mailRuntimeSource:'',capture:()=>()=>!this.closed,receive:async()=>null});
    try{
      const browser=await sandbox.getBrowser(),context=await browser.newContext();
      const page=await context.newPage();await page.goto('about:blank');
      await page.evaluate(()=>document.readyState);
      return {ok:true as const,code:'BROWSER_SANDBOX_READY',executable,version:browser.version()};
    }catch(error){
      const message=error instanceof Error?error.message:'';
      const code=/Running as root without --no-sandbox/.test(message)?'BROWSER_REQUIRES_NON_ROOT_USER'
        :/No usable sandbox|Chromium sandboxing failed|apparmor|Failed to move to new namespace/i.test(message)?'BROWSER_SANDBOX_UNAVAILABLE'
        :/error while loading shared libraries|Host system is missing dependencies|cannot open shared object/i.test(message)?'BROWSER_SYSTEM_DEPENDENCIES_MISSING':'BROWSER_LAUNCH_FAILED';
      return {ok:false as const,code,executable};
    }finally{await sandbox.close();}
  }

  /** Print an exact-binary policy for explicit administrator installation. */
  async sandboxProfile():Promise<string>{
    if(process.platform!=='linux')throw new Error('APPARMOR_LINUX_ONLY');
    const executable=await this.installed();if(!executable)throw new Error('BROWSER_NOT_INSTALLED');
    const file=await realpath(executable);
    if(!/^\/[\p{L}\p{N}_./ -]+$/u.test(file))throw new Error('BROWSER_SANDBOX_PATH_UNSUPPORTED');
    return `abi <abi/4.0>,\ninclude <tunables/global>\nprofile cindy-terminal-chromium "${file}" flags=(unconfined) {\n  userns,\n}\n`;
  }

  private async prepare(): Promise<string> {
    const installed=await this.installed();if(installed)return installed;
    const directory=path.join(this.options.root,'chromium');await privateDirectory(directory);
    const env={...process.env,PLAYWRIGHT_BROWSERS_PATH:directory};
    this.options.changed?.('installing');
    try {
      await new Promise<void>((resolve,reject) => {
        const child=spawn(terminalNodeExecutable(),[path.join(path.dirname(require.resolve('playwright-core/package.json')),'cli.js'),'install','chromium'],{env,stdio:'ignore',windowsHide:true,signal:this.abort.signal});
        child.once('error',reject);
        child.once('exit',code => code===0?resolve():reject(new Error('BROWSER_RUNTIME_INSTALL_FAILED')));
      });
      this.abort.signal.throwIfAborted();
      const executable=await this.installed();if(!executable)throw new Error('BROWSER_RUNTIME_INSTALL_FAILED');
      this.options.changed?.('ready');
      return executable;
    } catch (cause) { this.options.changed?.('failed'); throw new Error('BROWSER_RUNTIME_INSTALL_FAILED',{cause}); }
  }
  async close():Promise<void> { this.closed=true;this.abort.abort();await this.flight?.catch(()=>{}); }
}
