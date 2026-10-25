import path from 'node:path';
import { createProviderShareReshare, normalizeProviderShareReshareFile, RESHARE_STORE_MAX_BYTES, type ReshareFile, type ProviderShareReshareRecord } from '@cindy/remote-agent/host/reshare';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';

/** The identical Desktop approval/batch machine, with terminal-owned storage. */
export class TerminalReshares {
  readonly service: ReturnType<typeof createProviderShareReshare>;
  private value: ReshareFile = {records:[]};
  private readonly owner:string|null;
  private readonly ready:Promise<void>;
  private writes:Promise<void>=Promise.resolve();
  private closed=false;
  constructor(private readonly options:{profileDir:string;getOwnerScope():string|null;guestAccess(controller:string):unknown;revoked(records:readonly ProviderShareReshareRecord[]):void;changed():void}){
    this.owner=options.getOwnerScope();const file=path.join(options.profileDir,'provider-share-reshare.json');
    this.ready=(async()=>{await privateDirectory(options.profileDir);const raw=await readPrivateFile(file);if(raw)this.value=normalizeProviderShareReshareFile(JSON.parse(raw.toString()));})();
    this.service=createProviderShareReshare({guestAccess:options.guestAccess,store:{invalidateIfChanged(){},read:()=>this.value,updateAtomic:update=>{
      let result!:ReshareFile;
      const job=this.writes.then(async()=>{await this.ready;this.assertCurrent();result=update({value:this.value});const serialized=JSON.stringify(result);if(Buffer.byteLength(serialized)>RESHARE_STORE_MAX_BYTES)throw new Error('RESHARE_STORE_LIMIT');await atomicPrivateWrite(file,serialized);this.assertCurrent();this.value=result;});
      this.writes=job.catch(()=>undefined);return job.then(()=>result);
    }}});
    this.service.setProviderShareReshareEvents({requested:()=>options.changed(),changed:options.changed,revoked:options.revoked});
  }
  private assertCurrent(){if(this.closed||this.owner!==this.options.getOwnerScope())throw new Error('OWNER_CHANGED');}
  async open(){await this.ready;this.assertCurrent();}
  async list(){await this.open();return this.service.listProviderShareReshares();}
  async decide(id:string,decision:'approve'|'reject',guard:()=>void){await this.open();guard();const result=await this.service.decideProviderShareReshare(id,decision,Date.now(),()=>{this.assertCurrent();guard();});if(result?.previous==='approved'&&decision==='reject')this.options.revoked([result.record]);this.options.changed();return result;}
  async close(){await this.writes;this.closed=true;this.service.setProviderShareReshareEvents(null);}
}
