import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectDump } from './inspect-dump.mjs';

// A synthetic metadata-only dump. No process memory or user data in fixtures.
function fixture({ code = 0x80000003, rva = 0xA332D17, age = 1, guidWord = 0xD4DDA3CA } = {}) {
  const b = Buffer.alloc(512);
  b.write('MDMP'); b.writeUInt32LE(2, 8); b.writeUInt32LE(32, 12);
  b.writeUInt32LE(6, 32); b.writeUInt32LE(168, 36); b.writeUInt32LE(56, 40);
  b.writeUInt32LE(4, 44); b.writeUInt32LE(112, 48); b.writeUInt32LE(224, 52);
  b.writeUInt32LE(123, 56); b.writeUInt32LE(code, 64);
  b.writeBigUInt64LE(0x100000000n + BigInt(rva), 80);
  b.writeUInt32LE(1, 224);
  const module = 228;
  b.writeBigUInt64LE(0x100000000n, module); b.writeUInt32LE(0xD6FB000, module + 8);
  b.writeUInt32LE(350, module + 20); b.writeUInt32LE(400, module + 80);
  const name = Buffer.from('C:\\synthetic\\Cindy.exe', 'utf16le');
  b.writeUInt32LE(name.length, 350); name.copy(b, 354);
  b.write('RSDS', 400); b.writeUInt32LE(guidWord, 404);
  b.writeUInt16LE(0x101D, 408); b.writeUInt16LE(0x876E, 410);
  Buffer.from('4C4C44205044422E', 'hex').copy(b, 412); b.writeUInt32LE(age, 420);
  b.write('electron.exe.pdb\0', 424);
  return b;
}

test('only the exact exception + RVA + PDB GUID/age identifies the reported signature', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ax5406-parser-test-'));
  const file = path.join(root, 'synthetic.dmp');
  try {
    for (const [variation, expected] of [
      [{}, true], [{ code: 0xC0000005 }, false], [{ rva: 0xA332D27 }, false],
      [{ age: 2 }, false], [{ guidWord: 0xD4DDA3CB }, false],
    ]) {
      fs.writeFileSync(file, fixture(variation));
      const result = inspectDump(file);
      assert.equal(result.matchesReported5406, expected);
      assert.equal(result.threadId, 123);
      assert.equal(result.faultModule.name, 'Cindy.exe');
    }
    fs.writeFileSync(file, Buffer.from('not a dump'));
    assert.throws(() => inspectDump(file), /Not a minidump/);
    fs.writeFileSync(file, fixture().subarray(0, 70));
    assert.throws(() => inspectDump(file));
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
});
