import path from 'node:path';
import os from 'node:os';
import {access} from 'node:fs/promises';
import {createLiziMcpProviders,LspServerPool,type LiziMcpProvider} from '@cindy/mcps';
import type {Logger} from '@cindy/maker-core';
import type {PluginRegistry} from '@cindy/app-runtime/builtin-tools/plugin-registry';
import {createAndroidRuntime} from '@cindy/app-runtime/androidRuntime';
import {createAndroidAutomationSettings} from '@cindy/app-runtime/androidAutomationSettings';
import {createComputerRuntime} from '@cindy/app-runtime/computerRuntime';
import {createLspModeSettings} from '@cindy/app-runtime/lspModeSettings';
import {createNativeInputProbe} from '@cindy/app-runtime/nativeInputProbe';
import {createOutboundFetch} from '@cindy/app-runtime/outboundFetch';
import {createEnvOutboundProxyResolver} from '@cindy/anthropic-compat-proxy';
import {redactSshSensitiveText} from '@cindy/maker-remote-ssh';
import * as ownership from '@cindy/remote-agent/input-handoff/inputOwnership';
import {RUNTIME_DIRECTORY} from '../version.js';
import type {TerminalSshService} from '../ssh.js';
import {registerAndroidAutomationHandlers} from '@cindy/app-runtime/androidHandlers';
import type {IpcHandler} from '@cindy/app-runtime/ipcHandlerRegistry';
import {MAKER_INVOKE} from '@cindy/maker-shared/maker-channels';
import {throwIpcError} from '@cindy/remote-agent/ipcValidate';
import {TerminalBrowserTools} from './browser-tools.js';
import type {TerminalSecrets} from '../contracts.js';
import {TerminalDocumentTools} from './document-tools.js';

/** Original device drivers and MCP providers; only platform paths and network
 * resolution belong to the Node host. Drivers remain lazy until a tool is used. */
export class TerminalDeviceTools {
  readonly android;
  readonly androidSettings;
  readonly computer;
  readonly lspSettings;
  readonly providers:LiziMcpProvider[];
  readonly handlers=new Map<string,IpcHandler>();
  private readonly lsp:LspServerPool;
  readonly browser:TerminalBrowserTools;
  readonly documents:TerminalDocumentTools;
  private closed=false;
  constructor(private options:{profileDir:string;logger:Logger;plugins:PluginRegistry;secrets:TerminalSecrets;ssh?:TerminalSshService;desktopInputBinary?:()=>Promise<string>;assertCurrent():void;uploadRoots(id:string):Promise<string[]>}){
    const current=()=>{if(this.closed)throw new Error('DEVICE_TOOLS_CLOSED');options.assertCurrent();};
    const resolveProxy=createEnvOutboundProxyResolver();
    const network=createOutboundFetch({logger:options.logger,resolveOutboundProxy:resolveProxy});
    const getPath=(name:'userData'|'home'|'temp')=>{current();return name==='userData'?options.profileDir:name==='home'?os.homedir():os.tmpdir();};
    this.androidSettings=createAndroidAutomationSettings({userDataPath:()=>getPath('userData'),log:options.logger});
    this.android=createAndroidRuntime({getPath,getAppPath:()=>path.resolve(RUNTIME_DIRECTORY,'../../../desktop'),resourcesPath:()=>RUNTIME_DIRECTORY,
      logger:options.logger,readAndroidAutomationSettings:this.androidSettings.readAndroidAutomationSettings,outboundFetch:network.outboundFetch});
    const probe=createNativeInputProbe(async()=>{
      if(options.desktopInputBinary){current();const binary=await options.desktopInputBinary();current();return binary;}
      current();const binary=path.join(RUNTIME_DIRECTORY,'tools','remote-desktop',process.platform==='darwin'?'cindy-macos-desktop-input':'cindy-windows-desktop-input.exe');
      await access(binary);current();return binary;
    });
    this.computer=createComputerRuntime({...ownership,getPath,logger:options.logger,outboundFetch:network.outboundFetch,
      resolveDesktopOutboundProxy:async url=>resolveProxy(url),isSecureTarget:probe.isSecureInputTarget});
    this.lspSettings=createLspModeSettings({userDataPath:()=>getPath('userData'),log:options.logger});
    this.lsp=new LspServerPool({userDataPath:options.profileDir,logger:options.logger});
    this.browser=new TerminalBrowserTools(options);
    this.documents=new TerminalDocumentTools(options);
    const android=this.android.getAndroidMcpDeps({isAndroidAutomationEnabled:context=>context?.agentKind==='codex'||options.plugins.isEnabled('android')});
    const computer=this.computer.getComputerMcpDeps({isComputerUseEnabled:context=>context?.agentKind==='codex'||options.plugins.isEnabled('computer')});
    this.providers=createLiziMcpProviders({
      browser:this.browser.deps,
      docs:this.documents.deps,
      android:{...android,callTool:async(...args)=>{current();const result=await android.callTool(...args);current();return result;}},
      computer:{...computer,callTool:async(...args)=>{current();const result=await computer.callTool(...args);current();return result;}},
      lsp:{pool:this.lsp,logger:options.logger,isUserEnabled:()=>{current();return this.lspSettings.readLspModeSettings().enabled;}},
      ...(options.ssh?{ssh:{getPool:async()=>{current();const pool=await options.ssh!.getHydratedPool();current();return pool;},
        ensureReady:async(id:string)=>{current();await options.ssh!.ensureHostReady(id);current();},
        redactSensitiveText:(snapshot:Parameters<NonNullable<import('@cindy/mcps').SshMcpDeps['redactSensitiveText']>>[0],text:string)=>redactSshSensitiveText(snapshot.config,text),logger:options.logger}}:{}),
    });
    registerAndroidAutomationHandlers({handle:(channel,handler)=>this.handlers.set(channel,handler)},{
      getStatusSummary:()=>this.android.getAndroidStatusSummary(),getSettingsState:this.androidSettings.readAndroidAutomationSettingsState,
      setDefaultDeviceSerial:this.androidSettings.writeAndroidDefaultDeviceSerial,setAdbPathOverride:this.androidSettings.writeAndroidAdbPathOverride,
      prepareAdb:()=>this.android.prepareAndroidAdb(),
    });
    this.handlers.set(MAKER_INVOKE.LSP_MODE_GET,()=>this.lspSettings.readLspModeSettings());
    this.handlers.set(MAKER_INVOKE.LSP_MODE_SET,(_event,enabled)=>{
      if(typeof enabled!=='boolean')throwIpcError('INVALID_PARAMS','lsp mode enabled required (boolean)');
      this.lspSettings.writeLspModeEnabled(enabled);return {effective:'next-session' as const};
    });
    this.handlers.set(MAKER_INVOKE.COMPUTER_STATUS,(_event,options)=>this.computer.getComputerDriverStatus(options as Parameters<typeof this.computer.getComputerDriverStatus>[0]));
    this.handlers.set(MAKER_INVOKE.COMPUTER_DRIVER_ICON,async()=>({iconDataUrl:await this.computer.getComputerDriverAppIcon()}));
    this.handlers.set(MAKER_INVOKE.COMPUTER_CHECK_UPDATE,(_event,options)=>this.computer.checkComputerDriverUpdate(undefined,{force:(options as {force?:unknown}|undefined)?.force===true}));
  }
  async close(){if(this.closed)return;this.closed=true;this.android.disposeAndroidAdb();this.computer.cancelComputerDriverPermissionGrant();
    await Promise.all([this.computer.cleanupAllComputerDriverSessions(),this.lsp.shutdown(),this.browser.close(),this.documents.close()]);}
}
