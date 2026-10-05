/** Symbolize DbgEng-unwound PCs using the matching official Electron Breakpad symbols.
 * Usage: node symbolize-stack.mjs dump.dmp stack.txt electron.exe.sym
 * Export-symbol guesses from DbgEng are deliberately discarded.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { inspectDump } from './inspect-dump.mjs';
const [dump, stackFile, symbolFile] = process.argv.slice(2);
const metadata = inspectDump(dump);
const bytes = fs.readFileSync(stackFile);
const stack = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8');
const base = BigInt(metadata.faultModule.base);
const rows = [...stack.matchAll(/^([0-9a-f]+`[0-9a-f]+)\s+([0-9a-f]+`[0-9a-f]+)\s+:/gmi)];
if (!rows.length) throw new Error('No DbgEng kv frames found');
const pcs = [base + BigInt(metadata.faultModule.rva), ...rows.slice(0, -1).map(row => BigInt('0x' + row[2].replace('`', '')))];
const frames = pcs.map((pc, i) => ({ frame: i, pc: `0x${pc.toString(16)}`,
  module: pc >= base && pc < base + BigInt(metadata.faultModule.size) ? metadata.faultModule.name : 'other-module',
  rva: Number(pc - base),
  // Return addresses point past the calling instruction.
  lookup: Number(pc - base) - (i ? 1 : 0), function: null, source: null }));
const files = new Map();
let first = true;
for await (const line of readline.createInterface({ input: fs.createReadStream(symbolFile), crlfDelay: Infinity })) {
  if (first) {
    first = false;
    if (!line.startsWith(`MODULE windows x86_64 ${metadata.faultModule.pdb.symbolKey} `)) throw new Error('Symbols do not match dump PDB identity');
  }
  if (line.startsWith('FILE ')) { const match = /^FILE (\d+) (.*)$/.exec(line); if (match) files.set(Number(match[1]), match[2]); }
  else if (line.startsWith('FUNC ')) {
    const match = /^FUNC (?:m )?([\da-f]+) ([\da-f]+) [\da-f]+ (.*)$/i.exec(line);
    if (!match) continue;
    const address = parseInt(match[1], 16), size = parseInt(match[2], 16);
    for (const frame of frames) if (frame.lookup >= address && frame.lookup < address + size) {
      frame.function = match[3]; frame.offset = frame.rva - address;
    }
  } else if (/^[\da-f]+ /i.test(line)) {
    const match = /^([\da-f]+) ([\da-f]+) (\d+) (\d+)$/i.exec(line);
    if (!match) continue;
    const address = parseInt(match[1], 16), size = parseInt(match[2], 16);
    for (const frame of frames) if (frame.lookup >= address && frame.lookup < address + size) {
      frame.source = { file: files.get(Number(match[4])), line: Number(match[3]) };
    }
  }
}
console.log(JSON.stringify({ metadata, method: 'DbgEng x64 unwind + matching official Breakpad FUNC/line records; optimized inline frames not expanded',
  frames: frames.map(({ lookup, ...frame }) => ({ ...frame,
    rva: frame.module === 'other-module' ? null : `0x${frame.rva.toString(16)}` })) }, null, 2));
