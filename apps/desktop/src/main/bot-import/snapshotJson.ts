import type { ImportItem } from './types.js';

/** Walk JSON without copying an item graph or building a snapshot-sized string.
 * Native JSON.stringify still owns escaping/scalar semantics. Only the known
 * file-byte fields are replaced, exactly as in the compact checkpoint format. */
function* snapshotJson(items: ImportItem[], encodeBytes: (bytes: Buffer) => unknown): Generator<string> {
  const ancestors = new Set<object>();
  function* quoted(value: string): Generator<string> {
    // Most metadata consists of short keys/values. Keep them in one bounded
    // fragment instead of visiting separate quotes and contents for each field.
    if (value.length <= 16 * 1024) { yield JSON.stringify(value); return; }
    yield '"';
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 16 * 1024, value.length);
      // Splitting a surrogate pair would change native JSON/UTF-8 semantics.
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!) && /[\uDC00-\uDFFF]/.test(value[end]!)) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  }
  const omitted = (value: unknown) => value === undefined || typeof value === 'function' || typeof value === 'symbol';
  const jsonValue = (value: unknown, key: string): unknown =>
    value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function' ? value.toJSON(key) : value;
  type Context = 'items' | 'item' | 'files' | 'file' | undefined;
  function* visit(input: unknown, context: Context, key = '', normalized = false): Generator<string> {
    const value = normalized ? input : jsonValue(input, key);
    if (typeof value === 'string') { yield* quoted(value); return; }
    if (!value || typeof value !== 'object') { yield omitted(value) ? 'null' : JSON.stringify(value); return; }
    if (ancestors.has(value)) throw new TypeError('Circular snapshot metadata');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        yield '[';
        for (let index = 0; index < value.length; index++) {
          if (index) yield ',';
          yield* visit(value[index], context === 'items' ? 'item' : context === 'files' ? 'file' : undefined, String(index));
        }
        yield ']';
      } else {
        yield '{';
        let first = true;
        // Avoid Object.entries/map materializing another wide metadata array.
        for (const field in value) {
          if (!Object.hasOwn(value, field)) continue;
          let child = (value as Record<string, unknown>)[field];
          if (context === 'file' && field === 'bytes') child = encodeBytes(child as Buffer);
          child = jsonValue(child, field);
          if (omitted(child)) continue;
          if (!first) yield ',';
          first = false;
          yield* quoted(field); yield ':';
          yield* visit(child, context === 'item' && field === 'files' ? 'files'
            : context === 'item' && field === 'asset' ? 'file' : undefined, field, true);
        }
        yield '}';
      }
    } finally { ancestors.delete(value); }
  }
  yield* visit(items, 'items');
}

/** Byte-bounded work between event-loop turns; cancellation never retains a
 * partial preview or continues a retry under a different signed-in owner. */
export async function visitSnapshotJson(
  items: ImportItem[], encodeBytes: (bytes: Buffer) => unknown,
  consume: (text: string) => void, assertOwner: () => void = () => {},
): Promise<void> {
  assertOwner();
  let bytes = 0;
  const encode = (buffer: Buffer) => { bytes += buffer.length; return encodeBytes(buffer); };
  for (const text of snapshotJson(items, encode)) {
    consume(text);
    bytes += Buffer.byteLength(text);
    if (bytes >= 64 * 1024) {
      await new Promise<void>(resolve => setImmediate(resolve));
      assertOwner(); bytes = 0;
    }
  }
  assertOwner();
}
