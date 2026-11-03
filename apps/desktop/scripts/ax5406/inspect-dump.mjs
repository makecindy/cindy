/** Read only minidump exception/module metadata; no memory/string dump or upload.
 * This checks the reported build+RVA signature. It does NOT unwind/symbolize a stack.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function inspectDump(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'MDMP') throw new Error('Not a minidump');
  const count = b.readUInt32LE(8), directory = b.readUInt32LE(12);
  const streams = new Map();
  for (let i = 0; i < count; i++) {
    const at = directory + i * 12;
    streams.set(b.readUInt32LE(at), b.readUInt32LE(at + 8));
  }
  const exception = streams.get(6), modules = streams.get(4);
  if (exception === undefined || modules === undefined) throw new Error('Missing exception/module stream');
  const code = b.readUInt32LE(exception + 8), address = b.readBigUInt64LE(exception + 24);
  const moduleCount = b.readUInt32LE(modules);
  let faultModule;
  for (let i = 0; i < moduleCount; i++) {
    const at = modules + 4 + i * 108;
    const base = b.readBigUInt64LE(at), size = b.readUInt32LE(at + 8);
    if (address < base || address >= base + BigInt(size)) continue;
    const nameAt = b.readUInt32LE(at + 20);
    const name = b.toString('utf16le', nameAt + 4, nameAt + 4 + b.readUInt32LE(nameAt));
    const cv = b.readUInt32LE(at + 80);
    let pdb;
    if (b.toString('ascii', cv, cv + 4) === 'RSDS') {
      const hex = (n, width) => n.toString(16).padStart(width, '0').toUpperCase();
      const guid = hex(b.readUInt32LE(cv + 4), 8) + hex(b.readUInt16LE(cv + 8), 4) +
        hex(b.readUInt16LE(cv + 10), 4) + b.subarray(cv + 12, cv + 20).toString('hex').toUpperCase();
      const age = b.readUInt32LE(cv + 20);
      pdb = { guid, age, symbolKey: guid + age.toString(16).toUpperCase(),
        name: path.win32.basename(b.toString('utf8', cv + 24, b.indexOf(0, cv + 24))) };
    }
    faultModule = { name: path.win32.basename(name), base: `0x${base.toString(16)}`, size,
      rva: `0x${(address - base).toString(16).toUpperCase()}`, pdb };
    break;
  }
  return { file: path.resolve(file), threadId: b.readUInt32LE(exception),
    exceptionCode: `0x${code.toString(16).toUpperCase()}`, faultModule,
    matchesReported5406: code === 0x80000003 && faultModule?.rva === '0xA332D17' &&
      faultModule?.pdb?.symbolKey === 'D4DDA3CA101D876E4C4C44205044422E1' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of process.argv.slice(2)) console.log(JSON.stringify(inspectDump(file), null, 2));
}
