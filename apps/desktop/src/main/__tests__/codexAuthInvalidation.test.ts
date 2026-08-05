/**
 * codex-auth-invalidation 单测 — 真实 fs tmpdir fixture。
 *
 * 这套测试守护 2026-07-03 线上踩坑的修复:Codex token 被服务端判失效后,用户在 XDMaker
 * 里重新授权成功,但旧实现无条件清掉失效标记 + suppress,下一次 reconcile 又把 ~/.codex
 * 里未变的坏 token 硬链回来覆盖新 token → 服务端再次 invalidate → 授权「成功 → 几秒后
 * 失败」死循环。
 * 覆盖:
 *   - 标记读写与指纹匹配:写入后能读回、系统文件被改写(指纹变化)后不再匹配、损坏标记自愈删除
 *   - settleInvalidationMarkerAfterLogin(核心回归):系统文件未变 → keepSuppressed=true 且
 *     标记保留;系统文件已变 / 已删 / 无标记 → keepSuppressed=false 且标记被清
 *   - restoreInvalidationStateOnStartup:标记匹配 + 本地 auth.json 缺失 / 仍是坏 token
 *     → 恢复失效态;标记匹配 + 本地 auth.json 存在且是新 token(重启前已重新登录)
 *     → 只 suppress 不进失效态;
 *     标记过期 → 全清
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getCodexAuthInvalidationMarkerPath,
  readInvalidatedSystemCodexAuthMarker,
  markerMatchesCurrentSystemCodexAuth,
  writeInvalidatedSystemCodexAuthMarker,
  clearInvalidatedSystemCodexAuthMarker,
  settleInvalidationMarkerAfterLogin,
  restoreInvalidationStateOnStartup,
} from '../maker-host/codex-auth-invalidation';

let tmpRoot: string;
let codexHome: string;
let systemAuth: string;
let localAuth: string;

const BAD_SYSTEM_CONTENT = JSON.stringify({ tokens: { access_token: 'invalidated-token' } });
const STALE_LOCAL_CONTENT = JSON.stringify({ tokens: { access_token: 'invalidated-local-token' } });
const FRESH_LOCAL_CONTENT = JSON.stringify({ tokens: { access_token: 'fresh-token' } });

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-invalidation-test-'));
  codexHome = path.join(tmpRoot, 'codex-home');
  systemAuth = path.join(tmpRoot, 'system', 'auth.json');
  localAuth = path.join(codexHome, 'auth.json');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 模拟服务端判失效的时刻:系统 auth.json 在场并落盘失效标记。 */
function invalidateWithSystemAuthPresent(reason = 'token_invalidated'): void {
  fs.writeFileSync(systemAuth, BAD_SYSTEM_CONTENT, 'utf-8');
  writeInvalidatedSystemCodexAuthMarker(codexHome, systemAuth, reason);
}

/** 模拟 invalidate 前 codex-home 里已有另一份也被服务端判坏的本地 auth。 */
function invalidateWithSystemAndLocalAuthPresent(reason = 'token_invalidated'): void {
  fs.writeFileSync(systemAuth, BAD_SYSTEM_CONTENT, 'utf-8');
  fs.writeFileSync(localAuth, STALE_LOCAL_CONTENT, 'utf-8');
  writeInvalidatedSystemCodexAuthMarker(codexHome, systemAuth, reason, localAuth);
}

/** 模拟用户在本机 CLI 重登:重写系统 auth.json 让指纹变化(inode/size/mtime 至少变一样)。 */
function rewriteSystemAuth(): void {
  fs.rmSync(systemAuth, { force: true });
  fs.writeFileSync(
    systemAuth,
    JSON.stringify({ tokens: { access_token: 'relogged-token' } }),
    'utf-8',
  );
}

describe('marker read / write / match', () => {
  it('writes a marker with the current system auth fingerprint and reads it back', () => {
    invalidateWithSystemAuthPresent('refresh_token_reused');
    const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
    expect(marker).not.toBeNull();
    expect(marker!.reason).toBe('refresh_token_reused');
    expect(markerMatchesCurrentSystemCodexAuth(marker!, systemAuth)).toBe(true);
  });

  it('records the current local auth fingerprint when one is provided', () => {
    invalidateWithSystemAndLocalAuthPresent('refresh_token_reused');
    const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
    expect(marker).not.toBeNull();
    expect(marker!.localSha256).toEqual(expect.any(String));
  });

  it('does not write a marker when the system auth.json is absent', () => {
    writeInvalidatedSystemCodexAuthMarker(codexHome, systemAuth, 'token_invalidated');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
  });

  it('stops matching after the system auth.json is rewritten', () => {
    invalidateWithSystemAuthPresent();
    const marker = readInvalidatedSystemCodexAuthMarker(codexHome)!;
    rewriteSystemAuth();
    expect(markerMatchesCurrentSystemCodexAuth(marker, systemAuth)).toBe(false);
  });

  it('stops matching after the system auth.json is deleted', () => {
    invalidateWithSystemAuthPresent();
    const marker = readInvalidatedSystemCodexAuthMarker(codexHome)!;
    fs.rmSync(systemAuth);
    expect(markerMatchesCurrentSystemCodexAuth(marker, systemAuth)).toBe(false);
  });

  it('self-heals by deleting a corrupt marker file', () => {
    const file = getCodexAuthInvalidationMarkerPath(codexHome);
    fs.writeFileSync(file, 'not-json{{{', 'utf-8');
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('clearInvalidatedSystemCodexAuthMarker is idempotent', () => {
    invalidateWithSystemAuthPresent();
    clearInvalidatedSystemCodexAuthMarker(codexHome);
    clearInvalidatedSystemCodexAuthMarker(codexHome);
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
  });
});

describe('settleInvalidationMarkerAfterLogin (2026-07-03 回归)', () => {
  it('keeps suppression and the marker while ~/.codex still holds the invalidated token', () => {
    invalidateWithSystemAuthPresent();
    // 用户在 XDMaker 里重新授权成功, 新 token 写入 codex-home。
    fs.writeFileSync(localAuth, FRESH_LOCAL_CONTENT, 'utf-8');

    const { keepSuppressed } = settleInvalidationMarkerAfterLogin(codexHome, systemAuth);

    // 系统文件一个字节没变 → 必须继续 suppress, 且标记保留 (供重启后恢复 / 后续比对)。
    expect(keepSuppressed).toBe(true);
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).not.toBeNull();
  });

  it('clears the marker and allows reconcile once the system auth.json changed', () => {
    invalidateWithSystemAuthPresent();
    rewriteSystemAuth();
    fs.writeFileSync(localAuth, FRESH_LOCAL_CONTENT, 'utf-8');

    const { keepSuppressed } = settleInvalidationMarkerAfterLogin(codexHome, systemAuth);

    expect(keepSuppressed).toBe(false);
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
  });

  it('clears the marker when the system auth.json was deleted', () => {
    invalidateWithSystemAuthPresent();
    fs.rmSync(systemAuth);

    const { keepSuppressed } = settleInvalidationMarkerAfterLogin(codexHome, systemAuth);

    expect(keepSuppressed).toBe(false);
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
  });

  it('is a no-op pass-through when no marker exists', () => {
    fs.writeFileSync(systemAuth, BAD_SYSTEM_CONTENT, 'utf-8');
    const { keepSuppressed } = settleInvalidationMarkerAfterLogin(codexHome, systemAuth);
    expect(keepSuppressed).toBe(false);
  });
});

describe('restoreInvalidationStateOnStartup', () => {
  it('restores the invalidated state when the marker matches and no local auth.json exists', () => {
    invalidateWithSystemAuthPresent('token_invalidated');
    // invalidate() 会删掉本地 auth.json, 用户没再登录就重启了。
    const restored = restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth);
    expect(restored.suppressReconcile).toBe(true);
    expect(restored.invalidatedReason).toBe('token_invalidated');
  });

  it('restores the invalidated state when local auth.json is still hard-linked to the invalidated system auth', () => {
    invalidateWithSystemAuthPresent('token_invalidated');
    fs.linkSync(systemAuth, localAuth);

    const restored = restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth);

    expect(restored.suppressReconcile).toBe(true);
    expect(restored.invalidatedReason).toBe('token_invalidated');
  });

  it('restores the invalidated state when local auth.json is a copied stale invalidated token', () => {
    invalidateWithSystemAuthPresent('token_invalidated');
    fs.writeFileSync(localAuth, BAD_SYSTEM_CONTENT, 'utf-8');

    const restored = restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth);

    expect(restored.suppressReconcile).toBe(true);
    expect(restored.invalidatedReason).toBe('token_invalidated');
  });

  it('restores the invalidated state when local auth.json matches the invalidated local fingerprint', () => {
    invalidateWithSystemAndLocalAuthPresent('token_invalidated');

    const restored = restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth);

    expect(restored.suppressReconcile).toBe(true);
    expect(restored.invalidatedReason).toBe('token_invalidated');
  });

  it('suppresses reconcile but stays authenticated when a fresh local auth.json exists', () => {
    invalidateWithSystemAuthPresent();
    // 上次运行里用户已重新授权成功 (settle 保留了标记), 然后重启应用。
    fs.writeFileSync(localAuth, FRESH_LOCAL_CONTENT, 'utf-8');

    const restored = restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth);

    // 不能把已重新登录的用户重新打回「已失效」展示态; 但坏 token 仍要挡住。
    expect(restored.suppressReconcile).toBe(true);
    expect(restored.invalidatedReason).toBeNull();
  });

  it('clears everything when the system auth.json changed since invalidation', () => {
    invalidateWithSystemAuthPresent();
    rewriteSystemAuth();

    const restored = restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth);

    expect(restored.suppressReconcile).toBe(false);
    expect(restored.invalidatedReason).toBeNull();
    expect(readInvalidatedSystemCodexAuthMarker(codexHome)).toBeNull();
  });

  it('returns a clean state when no marker exists', () => {
    const restored = restoreInvalidationStateOnStartup(codexHome, systemAuth, localAuth);
    expect(restored.suppressReconcile).toBe(false);
    expect(restored.invalidatedReason).toBeNull();
  });
});
