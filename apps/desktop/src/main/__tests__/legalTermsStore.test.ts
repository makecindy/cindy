/**
 * legal-terms-store 的真实落盘行为。依据:协议更新确认会挡住整个应用,同意记录读写故障时
 * 不能把已同意的用户锁在外面(fail open)。经真实文件读写验证,不 mock 存储。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = vi.hoisted(() => ({ value: '' }));
vi.mock('electron', () => ({ app: { getPath: () => dir.value } }));

async function importStore() {
  // reset-modules: 模拟进程重启——store 的读缓存与本次运行内的同意状态都在模块级,重启后须重新读盘。
  vi.resetModules();
  return import('../legal-terms-store');
}
const file = () => path.join(dir.value, 'legal-terms-consent.json');

beforeEach(() => {
  dir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-terms-store-'));
});

afterEach(() => {
  fs.chmodSync(dir.value, 0o700);
  fs.rmSync(dir.value, { recursive: true, force: true });
});

describe('legal terms consent store', () => {
  it('reports outdated without a record and current after accepting, across restarts', async () => {
    const store = await importStore();
    expect(store.readLegalTermsConsentStatus()).toBe('outdated');

    store.acceptCurrentLegalTerms();
    expect(store.readLegalTermsConsentStatus()).toBe('current');

    const restarted = await importStore();
    expect(restarted.readLegalTermsConsentStatus()).toBe('current');
  });

  it('reports an old version as outdated', async () => {
    fs.writeFileSync(file(), JSON.stringify({ acceptedVersion: '2000-01' }));
    const store = await importStore();
    expect(store.readLegalTermsConsentStatus()).toBe('outdated');
  });

  // 损坏的记录不能被当成「从未同意」:那会把已同意的人挡住。
  it('reports an unreadable record as unknown and keeps the file', async () => {
    fs.writeFileSync(file(), '{not json');
    const store = await importStore();

    expect(store.readLegalTermsConsentStatus()).toBe('unknown');
    expect(fs.readFileSync(file(), 'utf8')).toBe('{not json');
  });

  // 目录只读时点「同意」写不进去,本次运行内仍视为已同意,不会反复被拦。
  // Windows 上 chmod 不能让目录只读,这条只在 POSIX 上验证。
  it.skipIf(process.platform === 'win32')('treats agreeing as accepted for this run when the record cannot be written', async () => {
    const store = await importStore();
    fs.chmodSync(dir.value, 0o500);

    expect(() => store.acceptCurrentLegalTerms()).not.toThrow();
    expect(store.readLegalTermsConsentStatus()).toBe('current');
  });
});
