import path from 'node:path';
import { createRequire } from 'node:module';
import { lstat, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LibraryBindingStore, relocateLibraryMetaOwner, assertLibraryMetaOwner, isLibraryOwnerId } from '@cindy/plugin-runtime/library/libraryBinding';
import { migrateGhostLibrary } from '@cindy/plugin-runtime/library/libraryMigrate';
import { trashGhostLibrary } from '@cindy/plugin-runtime/library/libraryTrash';
import { ghostInstallApprovalToken } from '@cindy/plugin-runtime/shared/ghost';
import { readPrivateFile } from '../platform.js';
import { LibraryVault, statfsFreeBytes } from '@cindy/plugin-runtime/library/libraryVault';
import { LibrarySqlService } from '@cindy/plugin-runtime/library/librarySqlService';
import { GhostLibrarySlot, type GhostLibrarySlotDeps } from '@cindy/plugin-runtime/library/librarySlot';
import { relocateLibraryStagingOwner } from '@cindy/plugin-runtime/library/libraryStaging';

const require = createRequire(import.meta.url);

/** The shared Library slot owns file/SQL/staging validation. The terminal host
 * supplies an owner root and a Node ABI worker, never a renderer or display. */
export class TerminalPluginLibrary {
  readonly bindings: LibraryBindingStore;
  readonly slot: GhostLibrarySlot;
  constructor(private readonly options: {
    root: string;
    runtimeDirectory: string;
    getGhost: GhostLibrarySlotDeps['getGhost'];
    current(): boolean;
    log?: GhostLibrarySlotDeps['log'];
    syncAgentReadonlyExtraDir?: GhostLibrarySlotDeps['syncAgentReadonlyExtraDir'];
  }) {
    this.bindings = new LibraryBindingStore({
      strictReads: true,
      getFile: () => path.join(options.root, 'libraries-binding.json'),
      getManagedRoots: () => [path.resolve(options.root, '../..')],
      getDefaultRoot: id => this.root(id), log: options.log,
    });
    this.slot = new GhostLibrarySlot({
      getGhost: id => options.current() ? options.getGhost(id) : null,
      bindingStore: this.bindings,
      getDefaultRoot: id => this.root(id),
      getStagingRoot: id => path.join(options.root, 'library-staging', id),
      captureOwnerScope: () => options.current() ? options.root : null,
      createVault: deps => new LibraryVault(deps),
      createSqlService: deps => new LibrarySqlService(deps),
      getDiskFreeBytes: statfsFreeBytes,
      workerScriptPath: () => path.join(options.runtimeDirectory, 'plugin-library-worker.mjs'),
      betterSqliteModulePath: () => require.resolve('better-sqlite3'),
      syncAgentReadonlyExtraDir: options.syncAgentReadonlyExtraDir,
      log: options.log,
    });
  }
  root(id: string) { return path.join(this.options.root, 'libraries', id); }

  async ids() {
    const entries=await readdir(path.join(this.options.root,'libraries'),{withFileTypes:true}).catch((error:NodeJS.ErrnoException)=>{
      if(error.code==='ENOENT')return [];throw error;
    });
    return [...new Set([...entries.filter(entry=>entry.isDirectory()).map(entry=>entry.name),...await this.bindings.listBindingIds()])].filter(isLibraryOwnerId);
  }

  /** Settings reads never open a vault, create a directory or repair metadata. */
  async overview(id:string) {
    if(!isLibraryOwnerId(id)||!this.options.current())throw new Error('PLUGIN_LIBRARY_UNAVAILABLE');
    const ghost=this.options.getGhost(id),location=await this.bindings.resolveLibraryRoot(id);
    let state:'ready'|'empty'|'unavailable'=location.root?'empty':'unavailable';
    let name=ghost?.manifest.name??id,bytes:number|null=null,files:number|null=null,identity:unknown=null;
    if(location.root){
      const entry=await lstat(location.root).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
      if(entry){
        identity=[entry.dev,entry.ino];
        state='unavailable';
        if(entry.isDirectory())try{
          await assertLibraryMetaOwner(location.root,id);
          const meta=JSON.parse((await readPrivateFile(path.join(location.root,'.cindy-library/meta.json')))!.toString());
          if(!ghost&&typeof meta.orphaned?.name==='string')name=meta.orphaned.name;
          state='ready';
          // A newly migrated library rebuilds its usage ledger lazily. Missing
          // statistics are unknown, not zero bytes or a damaged library.
          try{
            const raw=await readPrivateFile(path.join(location.root,'.cindy-library/usage.json'));
            const usage=raw?JSON.parse(raw.toString()):null;
            if(Number.isSafeInteger(usage?.bytes)&&usage.bytes>=0&&Number.isSafeInteger(usage?.files)&&usage.files>=0){bytes=usage.bytes;files=usage.files;}
          }catch{/* The vault owns usage reconciliation; settings stay read-only. */}
        }catch{/* Unreadable/corrupt libraries are never presented as empty. */}
      }
    }
    const revision=createHash('sha256').update(JSON.stringify([id,ghost?.dir,ghostInstallApprovalToken(ghost?.approval),location,identity])).digest('hex');
    if(!this.options.current())throw new Error('PLUGIN_HOST_CLOSED');
    return {id,name,state,bytes,files,revision,location:location.kind,root:location.root,orphaned:!ghost};
  }

  /** Caller holds the plugin installation queue and rechecks its UI target. */
  async change(id:string,operation:'relocate'|'default'|'trash',candidate:string|undefined,assertCurrent:()=>void){
    const slot=this.slot;slot.setRelocating(id,true);
    try{
      await slot.disposeGhost(id);assertCurrent();
      const location=await this.bindings.resolveLibraryRoot(id);assertCurrent();
      if(!location.root)throw new Error('PLUGIN_LIBRARY_UNAVAILABLE');
      if(operation==='trash'){
        await assertLibraryMetaOwner(location.root,id);assertCurrent();
        const result=await trashGhostLibrary(id,{resolveLibraryRoot:async()=>{assertCurrent();return (await this.bindings.resolveLibraryRoot(id)).root;},trashRoot:()=>path.join(this.options.root,'libraries-trash'),removeBinding:async()=>{assertCurrent();await this.bindings.removeBinding(id);},log:this.options.log});
        if(!result.ok)throw new Error(`PLUGIN_LIBRARY_${result.errorCode}`);
        return;
      }
      const reverting=operation==='default';
      const target=reverting?path.dirname(this.root(id)):candidate;
      if(!target||!path.isAbsolute(target)||target.includes('\0'))throw new Error('PLUGIN_LIBRARY_DIRECTORY_REQUIRED');
      if(reverting)await mkdir(target,{recursive:true,mode:0o700});
      if(path.resolve(location.root)===path.resolve(target,id))return;
      const exists=await lstat(location.root).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
      const applyBinding=async(directory:string)=>{assertCurrent();return this.bindings.setBinding(id,directory,statfsFreeBytes,{allowInsideManagedRoot:reverting});};
      if(exists){
        if(!exists.isDirectory())throw new Error('PLUGIN_LIBRARY_UNAVAILABLE');
        await assertLibraryMetaOwner(location.root,id);assertCurrent();
        const sql=new LibrarySqlService({workerScriptPath:()=>path.join(this.options.runtimeDirectory,'plugin-library-worker.mjs'),betterSqliteModulePath:()=>require.resolve('better-sqlite3'),log:this.options.log});
        try{
          const result=await migrateGhostLibrary({ghostId:id,fromRoot:location.root,candidate:target,allowInsideManagedRoot:reverting,
            deps:{getFile:()=>path.join(this.options.root,'libraries-binding.json'),getManagedRoots:()=>[path.resolve(this.options.root,'../..')],getDefaultRoot:key=>this.root(key),getDiskFreeBytes:statfsFreeBytes,log:this.options.log,
              copySqlite:async(from,to)=>{assertCurrent();const opened=await sql.open(from);if(!opened.ok)throw new Error(opened.code);const copied=await sql.backup(from,to);if(!copied.ok)throw new Error(copied.code);await sql.close(from);},
              checkSqliteHealthy:async file=>{assertCurrent();const opened=await sql.open(file);if(!opened.ok)return false;const checked=await sql.check(file);await sql.close(file);return checked.ok;},
            },applyBinding});
          if(!result.ok)throw new Error(`PLUGIN_LIBRARY_MIGRATION_${result.phase.toUpperCase()}`);
        }finally{await sql.dispose();}
      }else{
        if(location.kind==='custom')throw new Error('PLUGIN_LIBRARY_UNAVAILABLE');
        const result=await applyBinding(target);if(!result.ok)throw new Error(result.errorCode);
      }
      assertCurrent();
      if(reverting)await this.bindings.removeBinding(id);
    }finally{slot.setRelocating(id,false);}
  }

  /** Called inside the existing durable source archive transaction, after its
   * physical rename. Each shared relocation helper is restart/rollback safe. */
  async archive(from: string, to: string, assertCurrent: () => void) {
    assertCurrent();
    await this.bindings.relocateBinding(from, to);
    assertCurrent();
    await relocateLibraryMetaOwner(this.root(to), from, to, assertCurrent);
    await relocateLibraryStagingOwner(path.join(this.options.root, 'library-staging', to), from, to, this.options.root, assertCurrent);
    assertCurrent();
  }

  /** Mark an existing library only. Uninstall must neither create an empty
   * replacement for a missing disk nor delete any of the user's works. */
  async orphan(id: string, name: string) {
    const location = await this.bindings.resolveLibraryRoot(id);
    if (!location.root) return;
    const meta = await lstat(path.join(location.root, '.cindy-library', 'meta.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!meta?.isFile()) return;
    const vault = new LibraryVault({
      rootDir: () => location.root!, ghostId: id, locationKind: location.kind,
      ...(location.kind === 'custom' ? {
        customParentGrant: { realPathAtGrant: location.record.realPathAtGrant, identity: location.record.identity },
        allowCustomInit: false,
      } : {}), log: this.options.log,
    });
    try {
      const opened = await vault.open();
      if (!opened.ok || opened.state === 'unavailable') throw new Error('PLUGIN_LIBRARY_UNAVAILABLE');
      const failure = await vault.markOrphaned(name);
      if (failure) throw new Error(failure.errorCode);
    } finally { await vault.invalidate(); }
  }
  close() { return this.slot.disposeAll(); }
}
