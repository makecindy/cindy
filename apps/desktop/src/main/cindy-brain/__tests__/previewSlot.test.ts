/** previewSlot.test — 面板预览槽(preview)的假 deps 单测。 */

import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import { GhostPreviewSlot, type PreviewSlotDeps } from '../previewSlot';

function previewGhost(
  options: { hosts?: string[]; preview?: boolean; enabled?: boolean } = {},
): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'preview-ghost',
      name: 'Preview Ghost',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(options.preview !== false
        ? { preview: { hosts: options.hosts ?? ['*.example.dev', 'localhost'] } }
        : {}),
    },
    dir: '/fake/preview-ghost',
    enabled: options.enabled ?? true,
    iconDataUrl: 'data:image/png;base64,AAAA',
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<PreviewSlotDeps> = {}) {
  let clock = 0;
  const pushes: Array<Record<string, unknown>> = [];
  const deps: PreviewSlotDeps = {
    getGhost: () => previewGhost(),
    broadcast: vi.fn((payload) => {
      pushes.push(payload as unknown as Record<string, unknown>);
      return true;
    }),
    focusedSessionId: () => 'focused-session',
    now: () => (clock += 60_000),
    ...overrides,
  };
  return { slot: new GhostPreviewSlot(deps), deps, pushes };
}

describe('previewSlot · 资格审与 URL 守门', () => {
  it('未声明 preview 能力 / 未启用 一律 PERMISSION_DENIED', () => {
    const noSlot = makeSlot({ getGhost: () => previewGhost({ preview: false }) });
    expect(
      noSlot.slot.handleRequest('preview-ghost', { url: 'https://a.example.dev/' }),
    ).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    const disabled = makeSlot({ getGhost: () => previewGhost({ enabled: false }) });
    expect(
      disabled.slot.handleRequest('preview-ghost', { url: 'https://a.example.dev/' }),
    ).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });

  it('白名单外 / http 非 loopback / 内嵌凭证 = URL_NOT_ALLOWED', () => {
    const { slot } = makeSlot();
    for (const url of [
      'https://evil.com/',
      'http://a.example.dev/',
      'https://u:p@a.example.dev/',
      'file:///etc/passwd',
    ]) {
      expect(slot.handleRequest('preview-ghost', { url })).toMatchObject({
        ok: false,
        errorCode: 'URL_NOT_ALLOWED',
      });
    }
  });

  it('url 缺失 / sessionId 形状不合法 = INVALID_REQUEST', () => {
    const { slot } = makeSlot();
    expect(slot.handleRequest('preview-ghost', {})).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(
      slot.handleRequest('preview-ghost', {
        url: 'https://a.example.dev/',
        sessionId: 'bad session!',
      }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
  });
});

describe('previewSlot · 落点会话与广播', () => {
  it('显式 sessionId 优先;缺省落台前会话;身份三件套由主机填', () => {
    const { slot, pushes } = makeSlot();
    expect(
      slot.handleRequest('preview-ghost', {
        url: 'https://a.example.dev/build/1',
        sessionId: 'explicit-session',
      }),
    ).toEqual({ ok: true });
    expect(pushes[0]).toMatchObject({
      ghostId: 'preview-ghost',
      name: 'Preview Ghost',
      iconDataUrl: 'data:image/png;base64,AAAA',
      sessionId: 'explicit-session',
      url: 'https://a.example.dev/build/1',
    });
    expect(
      slot.handleRequest('preview-ghost', { url: 'http://localhost:5173/' }),
    ).toEqual({ ok: true });
    expect(pushes[1]).toMatchObject({ sessionId: 'focused-session' });
  });

  it('没有显式会话也没有台前会话 = HOST_NOT_READY,不广播', () => {
    const { slot, deps } = makeSlot({ focusedSessionId: () => null });
    expect(
      slot.handleRequest('preview-ghost', { url: 'https://a.example.dev/' }),
    ).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('一个宿主窗口都不在 = HOST_NOT_READY', () => {
    const { slot } = makeSlot({ broadcast: vi.fn(() => false) });
    expect(
      slot.handleRequest('preview-ghost', { url: 'https://a.example.dev/' }),
    ).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });

  it('限速按尝试记账:间隔不足 = RATE_LIMITED', () => {
    let clock = 0;
    const { slot } = makeSlot({ now: () => (clock += 1000) });
    expect(slot.handleRequest('preview-ghost', { url: 'https://a.example.dev/' }).ok).toBe(true);
    expect(slot.handleRequest('preview-ghost', { url: 'https://a.example.dev/' })).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
  });
});
