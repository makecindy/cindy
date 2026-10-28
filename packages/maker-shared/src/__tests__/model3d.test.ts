import { describe, expect, it } from 'vitest';
import {
  getModel3DFormat,
  isManagedModel3DUrl,
  isModel3DPath,
  MODEL3D_FORMATS,
} from '../model3d';

const HASH = 'a'.repeat(64);

describe('getModel3DFormat', () => {
  it.each([
    ['/work/chair.glb', 'glb'],
    ['C:\\work\\Chair.GLTF', 'gltf'],
    ['model.OBJ', 'obj'],
    ['xdt-file://local/?path=%2Ftmp%2Fa.fbx', 'fbx'],
    ['xdt-file://local/?path=C%3A%5Cwork%5Cb.OBJ&v=1', 'obj'],
    ['https://cdn.example.com/a/b.stl?v=2', 'stl'],
    ['https://cdn.example.com/a/b.ply#frag', 'ply'],
    // 磁盘路径里的 # / ? 是文件名的字面字符，不是 URL 的 hash / query
    ['/work/project#1/chair.glb', 'glb'],
    ['/work/chair#2.glb', 'glb'],
    ['/work/what?.obj', 'obj'],
    ['C:\\work\\project#1\\Chair.FBX', 'fbx'],
    ['xdt-file://local/?path=%2Fwork%2Fproject%231%2Fchair.glb', 'glb'],
    ['./models#v2/ship.stl', 'stl'],
    ['scene.dae', 'dae'],
    ['part.3mf', '3mf'],
    ['old.3DS', '3ds'],
    [`cindy-media://blobs/${HASH}.glb`, 'glb'],
  ])('%s → %s', (input, expected) => {
    expect(getModel3DFormat(input)).toBe(expected);
  });

  it.each([
    'archive.zip', // ZIP 不是模型
    'xdt-file://local/?path=%2Ftmp%2Fpack.zip',
    'xdt-file://local/',
    'xdt-file://local/?path=%E0%A4%A',
    'notes.txt',
    'glb', // 没有点：不是扩展名
    '.glb', // 隐藏文件，不是扩展名
    'trailing.',
    '/directory.glb/unknown',
    'C:\\dir.obj\\readme',
    '',
  ])('%s is not a model', (input) => {
    expect(getModel3DFormat(input)).toBeNull();
    expect(isModel3DPath(input)).toBe(false);
  });

  it('rejects non-string input without throwing', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(getModel3DFormat(value)).toBeNull();
    }
  });

  it('keeps the recognised format list free of archives', () => {
    expect(MODEL3D_FORMATS).not.toContain('zip' as never);
  });
});

describe('isManagedModel3DUrl', () => {
  it('accepts only exact cindy-media GLB blob urls', () => {
    expect(isManagedModel3DUrl(`cindy-media://blobs/${HASH}.glb`)).toBe(true);
    for (const bad of [
      `cindy-media://blobs/${HASH}.fbx`,
      `cindy-media://blobs/${HASH}.gltf`,
      `cindy-media://blobs/${HASH}.glb?x=1`,
      `cindy-media://blobs/${HASH}.glb `,
      ` cindy-media://blobs/${HASH}.glb`,
      `cindy-media://blobs/${HASH.toUpperCase()}.glb`,
      `cindy-media://blobs/${'a'.repeat(63)}.glb`,
      `cindy-media://client-wallpaper/${HASH}.glb`,
      `xdt-model://mivo-3d-cache/${HASH}.glb`,
      `https://example.com/${HASH}.glb`,
      '',
      undefined,
      null,
    ]) {
      expect(isManagedModel3DUrl(bad)).toBe(false);
    }
  });
});
