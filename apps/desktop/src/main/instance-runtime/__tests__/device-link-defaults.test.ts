import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {initializeCloudDeviceLinkDefaults} from '../device-link-defaults.js';
const dirs:string[]=[];
const fresh=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-settings-'));dirs.push(p);return p;};
afterEach(()=>{for(const p of dirs.splice(0))fs.rmSync(p,{recursive:true,force:true});});
it('enables conversation and desktop control for a fresh cloud profile',()=>{
 const dir=fresh();initializeCloudDeviceLinkDefaults(dir);const f=path.join(dir,'device-link-settings.json');
 expect(JSON.parse(fs.readFileSync(f,'utf8'))).toMatchObject({remoteControlEnabled:true,remoteDesktopEnabled:true});
 expect(fs.statSync(f).mode&0o777).toBe(0o600);
});
it.each(['{"remoteControlEnabled":false,"revokedControllers":["revoked"]}','{"remoteControlEnabled":true,"remoteDesktopEnabled":false}','{broken'])('preserves existing preferences even if corrupt: %s',value=>{
 const dir=fresh(),f=path.join(dir,'device-link-settings.json');fs.writeFileSync(f,value);initializeCloudDeviceLinkDefaults(dir);
 expect(fs.readFileSync(f,'utf8')).toBe(value);
});
