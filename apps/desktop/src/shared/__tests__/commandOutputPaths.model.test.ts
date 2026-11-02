import { describe, expect, it } from 'vitest';
import { extractCommandOutputPathCandidates as extract } from '../commandOutputPaths';

describe('3D model export calls', () => {
  it('treats export(...) with a literal path as an output', () => {
    expect(extract(`python3 -c 'import trimesh; trimesh.creation.box().export("out/cube.glb")'`)).toEqual(['out/cube.glb']);
    expect(extract(`python3 -c 'scene.export(file_obj="out/a.glb")'`)).toEqual(['out/a.glb']);
  });

  it('treats bpy export_scene.* filepath= as an output', () => {
    expect(extract(`blender -b -P x.py -c 'bpy.ops.export_scene.gltf(filepath="out/ship.glb")'`)).toEqual(['out/ship.glb']);
    expect(extract(`blender -b --python-expr 'bpy.ops.export_scene.fbx(filepath="/work/ship.fbx")'`)).toEqual(['/work/ship.fbx']);
  });

  it('still ignores a path that is only assigned to a variable', () => {
    expect(extract(`python3 -c 'p="out/cube.glb"; open(p,"wb").write(b"x")'`)).toEqual([]);
  });
});

describe('model downloads with a bare file name', () => {
  it('recognises the save path of `mivo file download <id> <path>`', () => {
    expect(extract('mivo file download 6ae1ccdff cube-lowpoly.glb')).toEqual(['cube-lowpoly.glb']);
    expect(extract('mivo -j file download 6ae1ccdff out/cube.glb')).toEqual(['out/cube.glb']);
    // 没给保存路径 → 落到配置的下载目录,没有可认的路径
    expect(extract('mivo file download 6ae1ccdff')).toEqual([]);
    expect(extract('mivo file download 6ae1ccdff --thumbnail')).toEqual([]);
    expect(extract('mivo file list')).toEqual([]);
  });

  it('accepts a bare model name after -o / --output but not other bare names', () => {
    expect(extract('curl -L -o cube-lowpoly.glb https://x/y')).toEqual(['cube-lowpoly.glb']);
    expect(extract('tool --output ship.fbx')).toEqual(['ship.fbx']);
    expect(extract('tool -o notes.txt')).toEqual([]);
    expect(extract('tool -o model.zip')).toEqual([]);
  });
});

describe('3D model export calls with a bare file name', () => {
  it('recognises the first argument or a path keyword of an export call', () => {
    expect(extract(`python3 -c 'import trimesh; trimesh.creation.box().export("cube.glb")'`)).toEqual(['cube.glb']);
    expect(extract(`python3 -c "mesh.export('ship.obj')"`)).toEqual(['ship.obj']);
    expect(extract(`python3 -c 'scene.export(file_obj="scene.glb")'`)).toEqual(['scene.glb']);
    expect(extract(`blender -b -P x.py -c 'bpy.ops.export_scene.gltf(filepath="ship.glb")'`)).toEqual(['ship.glb']);
  });

  it('ignores non-model names, non-export calls and variables', () => {
    expect(extract(`python3 -c 'df.export("report.csv")'`)).toEqual([]);
    expect(extract(`python3 -c 'mesh.export("cube.zip")'`)).toEqual([]);
    expect(extract(`python3 -c 'open("cube.glb","wb").write(b"x")'`)).toEqual([]);
    expect(extract(`python3 -c 'mesh.export(path)'`)).toEqual([]);
    expect(extract(`python3 -c 'mesh.reexport("cube.glb")'`)).toEqual([]);
  });
});

describe('3MF and 3DS outputs (extension starts with a digit)', () => {
  it('keeps them through every candidate filter', () => {
    expect(extract('tool -o part.3mf')).toEqual(['part.3mf']);
    expect(extract('tool --output out/part.3mf')).toEqual(['out/part.3mf']);
    expect(extract('mivo file download 6ae1ccdff old.3ds')).toEqual(['old.3ds']);
    expect(extract('mivo file download 6ae1ccdff out/part.3mf')).toEqual(['out/part.3mf']);
    expect(extract(`python3 -c 'mesh.export("part.3mf")'`)).toEqual(['part.3mf']);
  });
});
