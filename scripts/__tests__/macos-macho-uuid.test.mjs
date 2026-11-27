/**
 * 测试价值
 * - 生产入口与可观察结果：scripts/macos-macho-uuid.mjs 的 deriveMacAppMachoUuid 与
 *   patchMachoUuid / patchMachoUuidBuffer，验证薄包 64 位 Mach-O 与 Universal Fat 二进制的
 *   LC_UUID 替换、确定性派生及非法二进制拒绝。
 * - Bug／规则依据：2026-11-26 macOS 27.3 实测，同版本 Electron 主二进制共享原厂 LC_UUID 时
 *   nehelper 静默继承拒绝、不弹系统本地网络授权框也不把 App 列进系统设置；签名前改写唯一
 *   LC_UUID 后立即正常弹出原生授权框。
 * - 现有覆盖缺口：此前构建链无 Mach-O LC_UUID 改写逻辑与测试。
 * - 最小失败输入：薄包 64 位 Mach-O、两切片 Universal Fat Mach-O、缺失 LC_UUID 的 Mach-O、
 *   空 bundleId 或空 electronVersion。
 * - tier：unit（纯内存与临时文件，跨平台可跑，无 codesign 依赖）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveMacAppMachoUuid,
  formatUuidBytes,
  parseUuidBytes,
  patchMachoUuid,
  patchMachoUuidBuffer,
} from '../macos-macho-uuid.mjs';

function makeThinMachO64({ uuid, includeUuid = true, bigEndian = false } = {}) {
  const cmds = [];
  // A dummy LC_SEGMENT_64-like filler command (cmd=0x19, size=16) before LC_UUID
  const filler = Buffer.alloc(16);
  if (bigEndian) {
    filler.writeUInt32BE(0x19, 0);
    filler.writeUInt32BE(16, 4);
  } else {
    filler.writeUInt32LE(0x19, 0);
    filler.writeUInt32LE(16, 4);
  }
  cmds.push(filler);

  if (includeUuid) {
    const lcUuid = Buffer.alloc(24);
    if (bigEndian) {
      lcUuid.writeUInt32BE(0x1b, 0);
      lcUuid.writeUInt32BE(24, 4);
    } else {
      lcUuid.writeUInt32LE(0x1b, 0);
      lcUuid.writeUInt32LE(24, 4);
    }
    parseUuidBytes(uuid).copy(lcUuid, 8);
    cmds.push(lcUuid);
  }

  const commandsBuf = Buffer.concat(cmds);
  const header = Buffer.alloc(32);
  if (bigEndian) {
    header.writeUInt32LE(0xcffaedfe, 0); // MH_CIGAM_64
    header.writeUInt32BE(cmds.length, 16);
    header.writeUInt32BE(commandsBuf.length, 20);
  } else {
    header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
    header.writeUInt32LE(cmds.length, 16);
    header.writeUInt32LE(commandsBuf.length, 20);
  }
  const body = Buffer.from('payload-bytes-stay-untouched');
  return Buffer.concat([header, commandsBuf, body]);
}

function makeFatMachO(slices) {
  const headerSize = 8 + slices.length * 20;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(0xcafebabe, 0); // FAT_MAGIC
  header.writeUInt32BE(slices.length, 4);
  let offset = headerSize;
  for (let i = 0; i < slices.length; i++) {
    const base = 8 + i * 20;
    header.writeUInt32BE(offset, base + 8);
    header.writeUInt32BE(slices[i].length, base + 12);
    offset += slices[i].length;
  }
  return Buffer.concat([header, ...slices]);
}

test('deriveMacAppMachoUuid is deterministic and separates bundles and Electron versions', () => {
  const globalV1 = deriveMacAppMachoUuid('com.xd.cindy', '42.0.0');
  assert.equal(globalV1, deriveMacAppMachoUuid('com.xd.cindy', '42.0.0'));
  assert.match(globalV1, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(globalV1, deriveMacAppMachoUuid('com.xd.cindy.cn', '42.0.0'));
  assert.notEqual(globalV1, deriveMacAppMachoUuid('app.cindy.personal.abc', '42.0.0'));
  assert.notEqual(globalV1, deriveMacAppMachoUuid('com.xd.cindy', '43.0.0'));
  assert.throws(() => deriveMacAppMachoUuid('', '42.0.0'), /bundleId/);
  assert.throws(() => deriveMacAppMachoUuid('com.xd.cindy', '  '), /electronVersion/);
});

test('patchMachoUuidBuffer replaces LC_UUID in thin 64-bit Mach-O without altering surrounding bytes', () => {
  const oldUuid = '4c4c44ec-5555-3144-a1c6-857afad02b7c';
  const nextUuid = deriveMacAppMachoUuid('com.xd.cindy', '42.0.0');
  const source = makeThinMachO64({ uuid: oldUuid });

  const first = patchMachoUuidBuffer(source, nextUuid);
  assert.deepEqual(first.previous, [oldUuid]);
  assert.equal(first.uuid, nextUuid);
  assert.equal(first.buffer.length, source.length);
  // Second patch confirms the new UUID is actually encoded in the LC_UUID slot.
  const second = patchMachoUuidBuffer(first.buffer, oldUuid);
  assert.deepEqual(second.previous, [nextUuid]);
  assert.deepEqual(second.buffer, source);
});

test('patchMachoUuidBuffer patches every slice in a universal Fat Mach-O binary', () => {
  const armUuid = '11111111-2222-3333-4444-555555555555';
  const x64Uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const nextUuid = deriveMacAppMachoUuid('com.xd.cindy', '42.0.0');
  const fat = makeFatMachO([
    makeThinMachO64({ uuid: armUuid }),
    makeThinMachO64({ uuid: x64Uuid }),
  ]);

  const patched = patchMachoUuidBuffer(fat, nextUuid);
  assert.deepEqual(patched.previous, [armUuid, x64Uuid]);
  const verify = patchMachoUuidBuffer(patched.buffer, armUuid);
  assert.deepEqual(verify.previous, [nextUuid, nextUuid]);
});

test('patchMachoUuid updates a file in place and rejects non-Mach-O or UUID-less inputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macho-uuid-test-'));
  try {
    const file = path.join(dir, 'Cindy');
    const oldUuid = '4c4c44ec-5555-3144-a1c6-857afad02b7c';
    const nextUuid = deriveMacAppMachoUuid('app.cindy.personal.test', '42.0.0');
    fs.writeFileSync(file, makeThinMachO64({ uuid: oldUuid }));
    const res = patchMachoUuid(file, nextUuid);
    assert.deepEqual(res, { previous: [oldUuid], uuid: nextUuid });
    const reread = patchMachoUuidBuffer(fs.readFileSync(file), oldUuid);
    assert.deepEqual(reread.previous, [nextUuid]);

    assert.throws(() => patchMachoUuidBuffer(Buffer.from('short-buf'), nextUuid), /Truncated Mach-O/);
    assert.throws(() => patchMachoUuidBuffer(Buffer.alloc(64, 0x41), nextUuid), /Unsupported Mach-O/);
    assert.throws(() => patchMachoUuidBuffer(makeThinMachO64({ includeUuid: false }), nextUuid), /no LC_UUID/);
    assert.equal(formatUuidBytes(parseUuidBytes(nextUuid)), nextUuid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
