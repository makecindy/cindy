import { constants, inflateRawSync } from 'node:zlib';

/** Canonical model file types accepted by the media warehouse. */
export const MODEL_MIME_BY_EXT: Record<string, string> = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'model/obj',
  '.fbx': 'model/fbx', '.stl': 'model/stl', '.ply': 'model/ply',
  '.dae': 'model/vnd.collada+xml', '.3mf': 'model/3mf', '.3ds': 'model/3ds',
};

const utf8 = new TextDecoder('utf-8', { fatal: true });
const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const vertex = new RegExp(`^v\\s+${number}\\s+${number}\\s+${number}(?:\\s+${number})*\\s*$`, 'm');
const face = /^f\s+-?\d+(?:\/-?\d*)?(?:\/-?\d+)?(?:\s+-?\d+(?:\/-?\d*)?(?:\/-?\d+)?){2,}\s*$/m;

function text(bytes: Uint8Array): string {
  try { return utf8.decode(bytes).replace(/^\uFEFF/, ''); } catch { return ''; }
}
function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function indices(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(index => Number.isSafeInteger(index) && index >= 0));
}
function gltfStructure(value: unknown): boolean {
  if (!record(value) || !record(value.asset) || typeof value.asset.version !== 'string' || !/^2\.\d+$/.test(value.asset.version)) return false;
  const fields = ['scenes', 'nodes', 'meshes', 'buffers'];
  if (!fields.some(key => Array.isArray(value[key]) && value[key].length > 0)) return false;
  return fields.every(key => value[key] === undefined || (Array.isArray(value[key]) && value[key].every((item: unknown) => {
    if (!record(item)) return false;
    if (key === 'scenes') return indices(item.nodes);
    if (key === 'nodes') return indices(item.children);
    if (key === 'buffers') return Number.isSafeInteger(item.byteLength) && Number(item.byteLength) > 0 && (item.uri === undefined || typeof item.uri === 'string');
    return Array.isArray(item.primitives) && item.primitives.length > 0 && item.primitives.every(primitive => record(primitive) && record(primitive.attributes));
  })));
}

/** Only a candidate: callers must validate the complete, capped body before storing it. */
export function isModelMediaCandidate(bytes: Uint8Array, declaredMime = ''): boolean {
  if (Object.values(MODEL_MIME_BY_EXT).includes(declaredMime)) return true;
  const prefix = new TextDecoder().decode(bytes.subarray(0, 4096));
  return /^\s*(?:ply[\r\n]|solid(?:\s|$)|;\s*FBX|<COLLADA\b)/.test(prefix) ||
    /["']asset["']\s*:\s*\{/.test(prefix) || vertex.test(prefix) ||
    /<COLLADA\b/.test(prefix) ||
    prefix.startsWith('Kaydara FBX Binary  ') ||
    (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) ||
    (bytes.length >= 6 && bytes[0] === 0x4d && bytes[1] === 0x4d) ||
    (bytes.length >= 84 && view(bytes).getUint32(80, true) > 0 &&
      84 + view(bytes).getUint32(80, true) * 50 <= 256 * 1024 * 1024);
}

/** ZIP directory and bounded metadata verification; arbitrary ZIP files are never models. */
function is3mf(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  const data = view(bytes);
  for (let end = bytes.length - 22; end >= Math.max(0, bytes.length - 65557); end--) {
    if (data.getUint32(end, true) !== 0x06054b50 || end + 22 + data.getUint16(end + 20, true) !== bytes.length) continue;
    if (data.getUint16(end + 4, true) || data.getUint16(end + 6, true)) return false;
    const count = data.getUint16(end + 10, true);
    const centralEnd = data.getUint32(end + 16, true) + data.getUint32(end + 12, true);
    if (!count || count > 4096 || centralEnd !== end) return false;
    let cursor = data.getUint32(end + 16, true);
    let model = false;
    let contentTypes = false;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || data.getUint32(cursor, true) !== 0x02014b50) return false;
      const nameLength = data.getUint16(cursor + 28, true);
      const name = text(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\')) return false;
      if (/^3D\/[^/]+\.model$/i.test(name)) {
        const local = data.getUint32(cursor + 42, true);
        if (!data.getUint32(cursor + 24, true) || local + 30 > cursor || data.getUint32(local, true) !== 0x04034b50) return false;
        // Inspect only the XML head (bounded): a package whose model is not 3MF XML is not a model.
        const start = local + 30 + data.getUint16(local + 26, true) + data.getUint16(local + 28, true);
        const compressed = Math.min(data.getUint32(cursor + 20, true), 65536);
        if (start + compressed > cursor) return false;
        const method = data.getUint16(cursor + 10, true);
        const raw = bytes.subarray(start, start + compressed);
        let head: Uint8Array;
        try { head = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: 1 << 20 }) : new Uint8Array(); } catch { return false; }
        if (!/<model\b[^>]*\bxmlns\s*=\s*["']http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/core\/\d{4}\/\d{2}["']/.test(new TextDecoder().decode(head))) return false;
        model = true;
      }
      if (name === '[Content_Types].xml') {
        const local = data.getUint32(cursor + 42, true);
        const compressed = data.getUint32(cursor + 20, true);
        const size = data.getUint32(cursor + 24, true);
        if (size > 65536 || compressed > 65536 || local + 30 > bytes.length || data.getUint32(local, true) !== 0x04034b50 || (data.getUint16(cursor + 8, true) & 1)) return false;
        const start = local + 30 + data.getUint16(local + 26, true) + data.getUint16(local + 28, true);
        if (start + compressed > cursor) return false;
        const method = data.getUint16(cursor + 10, true);
        const raw = bytes.subarray(start, start + compressed);
        let metadata: Uint8Array;
        try { metadata = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: 65536 }) : new Uint8Array(); } catch { return false; }
        if (metadata.length !== size) return false;
        const xml = text(metadata);
        contentTypes = /<Types\b/.test(xml) && /application\/vnd\.ms-package\.3dmanufacturing-3dmodel\+xml/.test(xml);
      }
      cursor += 46 + nameLength + data.getUint16(cursor + 30, true) + data.getUint16(cursor + 32, true);
      if (cursor > end) return false;
    }
    return cursor === end && model && contentTypes;
  }
  return false;
}

/** Validate complete model bytes, never a filename or an upstream MIME declaration. */
export function sniffModelMediaMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 27 && text(bytes.subarray(0, 20)) === 'Kaydara FBX Binary  ' && bytes[20] === 0 && bytes[21] === 0x1a && bytes[22] === 0) return 'model/fbx';
  if (bytes.length >= 6 && bytes[0] === 0x4d && bytes[1] === 0x4d && view(bytes).getUint32(2, true) === bytes.length) {
    let offset = 6;
    while (offset + 6 <= bytes.length) {
      const length = view(bytes).getUint32(offset + 2, true);
      if (length < 6 || offset + length > bytes.length) return null;
      offset += length;
    }
    if (offset === bytes.length && offset > 6) return 'model/3ds';
  }
  if (bytes.length >= 84) {
    const triangles = view(bytes).getUint32(80, true);
    if (triangles > 0 && 84 + triangles * 50 === bytes.length) return 'model/stl';
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && is3mf(bytes)) return 'model/3mf';
  // Binary PLY has a textual header followed by arbitrary binary bytes.
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536))).split(/end_header\r?\n/, 1)[0];
  if (/^ply\r?\nformat (?:ascii|binary_little_endian|binary_big_endian) 1\.0\r?\n/.test(header) &&
    /(?:^|\n)element vertex [1-9]\d*\r?\n/.test(header) &&
    ['x', 'y', 'z'].every(axis => new RegExp(`(?:^|\\n)property (?:float|double|float32|float64) ${axis}\\r?\\n`).test(header)) &&
    /end_header\r?\n/.test(new TextDecoder().decode(bytes.subarray(0, 65536)))) return 'model/ply';
  const source = text(bytes);
  if (!source || source.includes('\0')) return null;
  if (/^\s*\{/.test(source)) {
    try {
      if (gltfStructure(JSON.parse(source))) return 'model/gltf+json';
    } catch { /* Ordinary or incomplete JSON is not a model. */ }
  }
  if (vertex.test(source) && face.test(source) && (source.match(/^v\s/gm)?.length ?? 0) >= 3) return 'model/obj';
  if (/^\s*;\s*FBX [\d.]+ project file/.test(source) && /FBXHeaderExtension\s*:/.test(source) && /Objects\s*:/.test(source)) return 'model/fbx';
  if (/^\s*(?:<\?xml[^?]*\?>\s*)?<COLLADA\b[^>]*\bxmlns\s*=\s*["']https?:\/\/www\.collada\.org\/[^"']+["'][^>]*>/.test(source) && /<library_geometries\b/.test(source) && /<\/COLLADA>\s*$/.test(source)) return 'model/vnd.collada+xml';
  if (/^\s*solid[^\r\n]*[\r\n]/.test(source) && /(?:^|\n)\s*endsolid[^\r\n]*\s*$/.test(source)) {
    const triple = `${number}\\s+${number}\\s+${number}`;
    const facet = new RegExp(`facet\\s+normal\\s+${triple}\\s+outer\\s+loop\\s+(?:vertex\\s+${triple}\\s+){3}endloop\\s+endfacet`, 'g');
    const body = source.replace(/^\s*solid[^\r\n]*[\r\n]/, '').replace(/(?:^|\n)\s*endsolid[^\r\n]*\s*$/, '');
    if (facet.test(body) && !body.replace(facet, '').trim()) return 'model/stl';
  }
  return null;
}
