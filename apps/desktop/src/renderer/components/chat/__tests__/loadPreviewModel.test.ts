import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mesh } from 'three';
import { loadPreviewModel } from '../loadPreviewModel';
import { embeddedModelResourceUrl } from '../modelPreviewResources';

/** Test value: the file-preview parser must not turn an authorized model into
 * arbitrary network/local-file access (Electron security rules §1–2).
 * Existing preview tests cover routing, not model bytes. A glTF buffer URI
 * targeting localhost is the minimal failure input. Unit tier, no network.
 * Standalone geometry can also be tested here without requiring WebGL. */
function file(name: string, content: string | Uint8Array): File {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { name, arrayBuffer: async () => bytes.buffer } as File;
}

afterEach(() => vi.restoreAllMocks());

describe('loadPreviewModel', () => {
  it.each(['https://example.com/a.bin', 'http://127.0.0.1/a.bin', 'file:///tmp/a.bin', 'xdt-file:///tmp/a.bin', 'cindy-media://blobs/a.bin', '../a.bin'])('blocks embedded resource %s before any request', async (uri) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const model = {
      asset: { version: '2.0' },
      buffers: [{ uri, byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    };
    await expect(loadPreviewModel(file('model.gltf', JSON.stringify(model)))).rejects.toThrow('External model resources');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads standalone OBJ geometry without fetching any other file', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const object = await loadPreviewModel(file('triangle.obj', 'mtllib other.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'));
    expect(object.children).toHaveLength(1);
    expect((object.children[0] as Mesh).geometry.getAttribute('position').count).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('also blocks external texture requests made by the binary 3DS parser', async () => {
    const chunk = (id: number, bytes: Uint8Array) => {
      const result = new Uint8Array(bytes.length + 6);
      const header = new DataView(result.buffer);
      header.setUint16(0, id, true);
      header.setUint32(2, result.length, true);
      result.set(bytes, 6);
      return result;
    };
    // 3DS main > mesh data > material > texture map > filename.
    const name = new TextEncoder().encode('https://example.com/texture.png\0');
    const bytes = chunk(0x4d4d, chunk(0x3d3d, chunk(0xafff, chunk(0xa200, chunk(0xa300, name)))));
    await expect(loadPreviewModel(file('model.3ds', bytes))).rejects.toThrow('External model resources');
  });

  it('allows inline resources but refuses protocol-relative and local paths', () => {
    for (const uri of ['data:application/octet-stream;base64,AAAA', 'blob:https://localhost/123']) {
      expect(embeddedModelResourceUrl(uri)).toBe(uri);
    }
    for (const uri of ['//example.com/texture.png', '/etc/passwd', 'C:\\private\\texture.png']) {
      expect(() => embeddedModelResourceUrl(uri)).toThrow('External model resources');
    }
  });
});
