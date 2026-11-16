// Unit: automatic defaults must prefer declared project artwork and never execute SVG/HTML.
import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { discoverProjectIcon, projectIconThumbnail, safeIconUrl, localIconPath } from '../projectIconDiscovery';
const png = await sharp({create:{width:8,height:8,channels:4,background:'#123456'}}).png().toBuffer();
it('prefers declared local artwork without contacting the network', async()=>{
  const fetch=vi.fn();
  const files:Record<string,Buffer>={'app.json':Buffer.from('{"expo":{"icon":"assets/brand.png"}}'),'assets/brand.png':png};
  const result=await discoverProjectIcon({read:async p=>files[p]??null,fetch});
  expect(result).toMatchObject({kind:'local',source:'assets/brand.png',candidate:false});
  expect(result?.image).toMatch(/^data:image\/png;base64,/);expect(fetch).not.toHaveBeenCalled();
});
it('finds a website manifest icon relative to its manifest, after invalid local icons', async()=>{
  const files:Record<string,Buffer>={'package.json':Buffer.from('{"homepage":"https://example.com/app"}'),'icon.png':Buffer.from('invalid')};
  const pages:Record<string,Buffer>={'https://example.com/app':Buffer.from('<link rel="manifest" href="/brand/app.webmanifest">'),'https://example.com/brand/app.webmanifest':Buffer.from('{"icons":[{"src":"icon.png"}]}'),'https://example.com/brand/icon.png':png};
  expect(await discoverProjectIcon({read:async p=>files[p]??null,fetch:async u=>pages[u]?{bytes:pages[u]!,url:u}:null})).toMatchObject({kind:'website',source:'https://example.com',candidate:false});
});
it('uses a GitHub repository website before offering its account avatar',async()=>{
  const fetch=vi.fn(async(url:string)=>({url,bytes:new URL(url).hostname === 'api.github.com'?Buffer.from(JSON.stringify({homepage:'https://site.example',owner:{avatar_url:'https://avatars.example/icon.png'}})):url==='https://site.example/'?Buffer.from('<link rel="icon" href="/brand.png">'):png}));
  const io={read:async()=>null,gitOrigin:async()=> 'git@github.com:team/project.git',fetch};
  expect(await discoverProjectIcon(io)).toMatchObject({kind:'website',candidate:false});
  expect(fetch.mock.calls.some(([u])=>new URL(u).hostname === 'avatars.example')).toBe(false);
  const result=await discoverProjectIcon({...io,fetch:async(url:string)=>new URL(url).hostname === 'api.github.com'?{url,bytes:Buffer.from('{"owner":{"avatar_url":"https://avatars.example/icon.png"}}')}:{url,bytes:png}});
  expect(result).toMatchObject({kind:'github',source:'https://github.com/team',candidate:true});
});
it('rejects external-resource SVGs, credentials, protocols and escaping local paths',async()=>{
  for(const svg of ['<svg><image href="file:///etc/passwd"/></svg>','<!DOCTYPE svg><svg/>','<svg><style>@import "https://example.com";</style></svg>'])expect(await projectIconThumbnail(Buffer.from(svg))).toBeNull();
  expect(safeIconUrl('https://user:pass@example.com/a')).toBeNull();
  expect(safeIconUrl('file:///a')).toBeNull();expect(safeIconUrl('http://example.com')).toBeNull();
  expect(localIconPath('../../secret')).toBeNull();expect(localIconPath('/etc/passwd')).toBeNull();
  expect(localIconPath('icon.png','public')).toBe('public/icon.png');
});
it('rasterizes simple SVG and extracts a PNG-backed ICO without retaining active content',async()=>{
  expect(await projectIconThumbnail(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>'))).toMatch(/^data:image\/png;/);
  const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  expect(await projectIconThumbnail(Buffer.concat([header,png]))).toMatch(/^data:image\/png;/);
});
