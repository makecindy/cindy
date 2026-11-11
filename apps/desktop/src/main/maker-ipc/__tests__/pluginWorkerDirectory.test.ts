import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, stat, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolvePluginWorkerDirectory } from '../pluginWorkerDirectory.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {...fs, realpath: vi.fn(fs.realpath), stat: vi.fn(fs.stat)};
});

it.each(['\\\\attacker\\share', '//attacker/share', '/\\attacker/share', '\\\\?\\UNC\\attacker\\share', '\\\\.\\pipe\\name', '\\??\\UNC\\attacker\\share', '//?/GLOBALROOT/Device/Mup/attacker/share'])('rejects network/device path %s without filesystem lookup', async requested => {
  vi.clearAllMocks();
  await expect(resolvePluginWorkerDirectory({requested, configuredDirectory: requested, isPickedDirectory: () => true, assertCurrent: () => {}})).rejects.toMatchObject({code: 'PERMISSION_DENIED'});
  expect(realpath).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
});

it('rejects ungranted local candidates and traversal before lookup', async () => {
  const leadDirectory = path.resolve('allowed');
  for (const requested of [path.resolve('elsewhere'), path.join(leadDirectory, '..', 'private')]) {
    vi.clearAllMocks();
    await expect(resolvePluginWorkerDirectory({requested, leadDirectory, isPickedDirectory: () => false, assertCurrent: () => {}})).rejects.toMatchObject({code: 'PERMISSION_DENIED'});
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  }
});

describe('plugin Worker directory authorization', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
  it('binds picked grants to the selected real target, not a replaceable alias', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'plugin-picked-'))); roots.push(root);
    const selected = path.join(root, 'selected'), other = path.join(root, 'other'), alias = path.join(root, 'alias');
    await mkdir(selected); await mkdir(other); await mkdir(path.join(selected, 'child'));
    await symlink(selected, alias, 'junction');
    const input = {requested: alias, isPickedDirectory: (dir: string) => dir === selected || dir === alias, assertCurrent: () => {}};
    // An unregistered alias cannot be probed merely to discover a picked target.
    await expect(resolvePluginWorkerDirectory({...input, isPickedDirectory: dir => dir === selected})).rejects.toMatchObject({code: 'PERMISSION_DENIED'});
    expect(await resolvePluginWorkerDirectory(input)).toBe(selected);
    await expect(resolvePluginWorkerDirectory({...input, requested: path.join(selected, 'child')})).rejects.toMatchObject({code: 'PERMISSION_DENIED'});
    await rm(alias); await symlink(other, alias, 'junction');
    await expect(resolvePluginWorkerDirectory(input)).rejects.toMatchObject({code: 'PERMISSION_DENIED'});
    // Legacy alias-only records cannot prove the originally selected target.
    await expect(resolvePluginWorkerDirectory({...input, isPickedDirectory: dir => dir === alias})).rejects.toMatchObject({code: 'PERMISSION_DENIED'});
  });
  it('allows the task and its real children, configured or picked roots, without granting Library', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(),'plugin-dirs-'))); roots.push(root);
    const dirs = ['task','task/child','task-other','configured','picked','library'];
    for (const dir of dirs) await mkdir(path.join(root,dir),{recursive:true});
    const input = {leadDirectory:path.join(root,'task'),configuredDirectory:path.join(root,'configured'),isPickedDirectory:(dir:string)=>dir===path.join(root,'picked'),assertCurrent:()=>{}};
    for (const dir of ['task','task/child','configured','picked']) expect(await resolvePluginWorkerDirectory({...input,requested:path.join(root,dir)})).toBe(path.join(root,dir));
    for (const dir of ['task-other','library']) await expect(resolvePluginWorkerDirectory({...input,requested:path.join(root,dir)})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(resolvePluginWorkerDirectory({...input,requested:path.join(root,'task','..','library')})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await symlink(path.join(root,'library'),path.join(root,'task','escape'),'junction');
    await expect(resolvePluginWorkerDirectory({...input,requested:path.join(root,'task','escape')})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(resolvePluginWorkerDirectory({...input,isPickedDirectory:()=>false,requested:path.join(root,'picked')})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  });
  it('rechecks ownership after asynchronous resolution', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(),'plugin-owner-'))); roots.push(root);
    const assertCurrent = vi.fn().mockImplementationOnce(()=>{}).mockImplementation(()=>{throw Error('Account changed');});
    await expect(resolvePluginWorkerDirectory({requested:root,leadDirectory:root,isPickedDirectory:()=>false,assertCurrent})).rejects.toThrow('Account changed');
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
});


it.each(['configuredDirectory', 'leadDirectory'] as const)('does not retarget a stored %s grant through a replacement link', async key => {
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'plugin-root-identity-')));
 try {
  const selected=path.join(root,'selected'), other=path.join(root,'other');
  await mkdir(selected);await mkdir(other);
  const input={requested:selected,[key]:selected,isPickedDirectory:()=>false,assertCurrent:()=>{}};
  expect(await resolvePluginWorkerDirectory(input)).toBe(selected);
  await rename(selected,path.join(root,'old'));await symlink(other,selected,'junction');
  await expect(resolvePluginWorkerDirectory(input)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  await expect(resolvePluginWorkerDirectory({...input,requested:other})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  // An independent exact pick can still authorize that real target.
  expect(await resolvePluginWorkerDirectory({...input,isPickedDirectory:dir=>dir===other})).toBe(other);
 } finally {await rm(root,{recursive:true,force:true});}
});
