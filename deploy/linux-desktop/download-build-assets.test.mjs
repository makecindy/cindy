import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {downloadPinnedAssets} from './download-build-assets.mjs';
const bytes=Buffer.from('verified synthetic asset'),sha=createHash('sha256').update(bytes).digest('hex');
const pin=['asset.tar.gz','https://assets.invalid/asset.tar.gz',sha];
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cindy-build-assets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return [root,path.join(root,'cache')];}
test('verified cache avoids repeat network and produces exact artifact',t=>{const [r,c]=fixture(t);let calls=0;const download=(_,f)=>{calls++;fs.writeFileSync(f,bytes)};downloadPinnedAssets([pin],r,c,download);downloadPinnedAssets([pin],r,c,download);assert.equal(calls,1);assert.deepEqual(fs.readFileSync(path.join(r,pin[0])),bytes);});
test('corrupt cache must be replaced by verified download',t=>{const[r,c]=fixture(t);fs.mkdirSync(c);fs.writeFileSync(path.join(c,sha),'corrupt');let calls=0;downloadPinnedAssets([pin],r,c,(_,f)=>{calls++;fs.writeFileSync(f,bytes)});assert.equal(calls,1);assert.deepEqual(fs.readFileSync(path.join(c,sha)),bytes);});
test('partial network failure cannot enter cache or output',t=>{const[r,c]=fixture(t);assert.throws(()=>downloadPinnedAssets([pin],r,c,(_,f)=>{fs.writeFileSync(f,'partial');throw Error('connection lost')}),/connection lost/);assert.deepEqual(fs.readdirSync(c),[]);assert.equal(fs.existsSync(path.join(r,pin[0])),false);});
test('incorrect completed download fails checksum and is not cached',t=>{const[r,c]=fixture(t);assert.throws(()=>downloadPinnedAssets([pin],r,c,(_,f)=>fs.writeFileSync(f,'wrong')),/ASSET_CHECKSUM/);assert.deepEqual(fs.readdirSync(c),[]);assert.equal(fs.existsSync(path.join(r,pin[0])),false);});
test('invalid source pins fail before download',t=>{const[r,c]=fixture(t);for(const bad of [['..',pin[1],sha],['.',pin[1],sha],['../asset',pin[1],sha],[pin[0],'http://assets.invalid/',sha],[pin[0],pin[1],'bad']])assert.throws(()=>downloadPinnedAssets([bad],r,c,()=>assert.fail('download attempted')),/INVALID_ASSET_PIN/);});
