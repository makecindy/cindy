import fs from 'node:fs';
import path from 'node:path';
import { PluginMarketLedger, type PluginMarketInstallationRecord } from '@cindy/plugin-runtime/market/ledger';
import { createOrganizationPrefixStore } from '@cindy/plugin-runtime/market/organizationPrefixStore';
import { loadGhostFirstPartyFactsLoader, bindPendingMarketRecordToInspectedPackage, type GhostFirstPartyFactsOverrides } from '@cindy/plugin-runtime/store/ghostFirstPartyFacts';
import { authorizeGhostHostPrimitive, authorizeGhostTokenBroker } from '@cindy/plugin-runtime/store/ghostFirstPartyPrivilege';
import { loadConnectionAudienceResolver } from '@cindy/plugin-runtime/connectionAudienceResolver';
import { readInstalledGhostManifestSnapshot } from '@cindy/plugin-runtime/store/installedGhostManifest';
import { installedMarketManifestIdentity } from '@cindy/plugin-runtime/market/installedManifestIdentity';
import { installedGhostStoragePart, installedGhostPhysicalRelId, pluginLedgerRecordKey, findInstalledGhostForDeliveryTarget, parsePluginStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import type { InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import { atomicWriteFileSync } from '@cindy/remote-agent/atomicWriteFile';
import type { TerminalPluginAccount } from './account.js';
import type { TerminalPlugins } from './host.js';
import { resolveInstalledGhost } from '@cindy/plugin-runtime/shared/pluginIdentity';
import { isTrustedXdGhostForScriptTarget } from '@cindy/plugin-runtime/ghostTrustedXdTarget';

type Organization=NonNullable<Awaited<ReturnType<TerminalPluginAccount['catalog']>>['currentOrganization']>;
type Commit={ghostId:string;namespace:string|null;sha256:string;previousRevision:string|null;previous:PluginMarketInstallationRecord|null;next:PluginMarketInstallationRecord|null};

/** Uses the same receipt/organization gates as Desktop. The market journal
 * closes the crash window between committing a package and its provenance. */
export class TerminalPluginIdentity {
  readonly ledger:PluginMarketLedger;
  private readonly directory:string;
  private readonly facts:ReturnType<typeof loadGhostFirstPartyFactsLoader>;
  private readonly audience:ReturnType<typeof loadConnectionAudienceResolver>;
  private readonly prefixes:ReturnType<typeof createOrganizationPrefixStore>;
  constructor(root:string,private readonly host:()=>TerminalPlugins,private readonly account:TerminalPluginAccount|undefined,private readonly guard:()=>void){
    this.directory=path.join(root,'plugin-market');
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    this.ledger=new PluginMarketLedger(path.join(this.directory,'ledger.v1.json'));
    this.prefixes=createOrganizationPrefixStore(path.join(this.directory,'organization.v1.json'));
    const manager=()=>{guard();return host().native.manager;};
    const find=(id:string)=>host().native.list().find(item=>installedGhostStoragePart(item)===id||installedGhostPhysicalRelId(item)===id);
    const base={readApprovedPackageSha256:(id:string)=>manager().approvedInstallEvidence(id)?.packageSha256??null,
      readInstallOrigin:(id:string)=>manager().readEffectiveInstallOrigin(id),readInstallNamespace:(id:string)=>manager().readDeliveryNamespace(id),
      readNamespaceState:(id:string)=>manager().readNamespaceState(id),lookupOrganizationPrefix:(id:string)=>this.prefixes.lookup(id),
      isPendingLegacyForge:(id:string)=>manager().isPendingLegacyForge(id),isPendingLegacyNamespace:(id:string)=>manager().isPendingLegacyNamespace(id),
    };
    const record=(id:string)=>{const ghost=find(id);return ghost?this.record(ghost):null;};
    this.facts=loadGhostFirstPartyFactsLoader({...base,readInstalledBuiltin:()=>false,readMarketInstallation:record});
    this.audience=loadConnectionAudienceResolver({...base,readMarketInstallation:record,readInstalledManifestIdentity:id=>{
      const ghost=find(id);if(!ghost)return null;const snapshot=readInstalledGhostManifestSnapshot(ghost.dir,512*1024);
      return snapshot.ok?installedMarketManifestIdentity(snapshot.snapshot):null;
    }});
  }
  record(ghost:InstalledGhost){
    this.guard();const record=this.ledger.installationForAuthorization({ghostId:ghost.manifest.id,namespace:ghost.namespace??null});
    if(record?.source==='market'&&record.serverRoot!==this.account?.serverRoot())return null;
    return record;
  }
  rememberOrganization(organization:Organization){
    this.guard();if(this.account?.membership()?.orgId!==organization.organizationId)throw new Error('PLUGIN_ORGANIZATION_CONTEXT_CHANGED');
    this.prefixes.remember(organization.organizationId,organization.pluginPrefix);
    atomicWriteFileSync(path.join(this.directory,'current-organization.json'),JSON.stringify({organization,serverRoot:this.account.serverRoot()}));
  }
  private identity(){
    this.guard();const member=this.account?.membership();let orgSlug:string|null=null;
    try{const saved=JSON.parse(fs.readFileSync(path.join(this.directory,'current-organization.json'),'utf8'));if(saved.serverRoot===this.account?.serverRoot()&&saved.organization?.organizationId===member?.orgId&&typeof saved.organization.orgSlug==='string')orgSlug=saved.organization.orgSlug;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('PLUGIN_ORGANIZATION_CACHE_UNAVAILABLE');}
    return {membershipKind:member?.kind??'personal',orgId:member?.orgId??null,orgSlug};
  }
  brokerAllowed(id:string,overrides?:GhostFirstPartyFactsOverrides){
    try{return authorizeGhostTokenBroker(id,this.facts.load(id,overrides?'install':'runtime',this.identity(),overrides));}catch{return false;}
  }
  hostAllowed(id:string){try{return authorizeGhostHostPrimitive(id,this.facts.load(id,'runtime',this.identity()));}catch{return false;}}
  findTrustedXdGhostForScript(id: string): InstalledGhost | null {
    this.guard();
    const ghosts = this.host().native.list();
    const preferred = resolveInstalledGhost(ghosts, id, 'xd');
    const resolved = preferred.status === 'unique' ? preferred : resolveInstalledGhost(ghosts, id);
    if (resolved.status !== 'unique') return null;
    const ghost = resolved.ghost, storagePart = installedGhostStoragePart(ghost);
    return isTrustedXdGhostForScriptTarget(ghost, this.facts.load(storagePart, 'runtime', this.identity()),
      this.host().native.manager.isPendingLegacyNamespace(storagePart)) ? ghost : null;
  }
  connection(id:string){
    this.guard();const member=this.account?.membership();if(!member)return null;
    return this.audience.resolve(id,{...this.identity(),membershipId:member.id});
  }
  assertInstall(input:{manifest:InstalledGhost['manifest'];packageSha256:string;namespace:string|null;installOrigin:'manual'|'agent-forge';record?:PluginMarketInstallationRecord}){
    this.guard();if(!input.manifest.network?.secrets?.some(secret=>secret.oauth?.tokenBroker))return;
    const overrides:GhostFirstPartyFactsOverrides={namespace:input.namespace,installOrigin:input.installOrigin,
      marketRecord:input.record?bindPendingMarketRecordToInspectedPackage(input.record,input.packageSha256):null};
    if(!this.brokerAllowed(input.manifest.id,overrides))throw new Error('PLUGIN_BROKER_FORBIDDEN');
  }
  begin(ghostId:string,namespace:string|null,sha256:string,previous:InstalledGhost|null,next?:PluginMarketInstallationRecord){
    this.guard();const transaction:Commit={ghostId,namespace,sha256,previousRevision:previous?.approval?.state==='approved'?previous.approval.revision:null,previous:previous?this.record(previous):null,next:next??null};
    atomicWriteFileSync(path.join(this.directory,'install.pending.json'),JSON.stringify(transaction));
  }
  recover(){
    this.guard();const file=path.join(this.directory,'install.pending.json');let commit:Commit;
    try{commit=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('PLUGIN_MARKET_JOURNAL_INVALID');}
    if(typeof commit?.ghostId!=='string'||!/^[a-f0-9]{64}$/.test(commit.sha256)||(commit.namespace!==null&&typeof commit.namespace!=='string'))throw new Error('PLUGIN_MARKET_JOURNAL_INVALID');
    const ghost=findInstalledGhostForDeliveryTarget(this.host().native.manager.list(),{ghostId:commit.ghostId,namespace:commit.namespace});
    if(ghost&&ghost.approval?.state!=='approved')throw new Error('PLUGIN_MARKET_RECOVERY_PENDING');
    const evidence=ghost?this.host().native.manager.approvedInstallEvidence(installedGhostStoragePart(ghost)):null;
    if(ghost?.approval?.state==='approved'&&ghost.approval.revision!==commit.previousRevision&&evidence?.packageSha256===commit.sha256){
      if(commit.previous&&(!commit.next||pluginLedgerRecordKey(commit.previous)!==pluginLedgerRecordKey(commit.next)))this.ledger.markRemovedRecordIfUnchanged(commit.previous,null);
      if(commit.next)this.ledger.upsertInstallation(commit.next);
    }
    this.guard();fs.unlinkSync(file);
  }
  removed(ghost:InstalledGhost,userInitiated=true){
    this.guard();const record=this.record(ghost);if(record)this.ledger.markRemovedRecordIfUnchanged(record,userInitiated?this.account?.membership()?.id??null:null);
  }
  finishRemoval(id:string){
    this.guard();const identity=parsePluginStoragePart(id);if(!identity)throw new Error('PLUGIN_ID_INVALID');
    const record=this.ledger.installationForAuthorization(identity);
    if(record)this.ledger.markRemovedRecordIfUnchanged(record,this.account?.membership()?.id??null);
  }
}
