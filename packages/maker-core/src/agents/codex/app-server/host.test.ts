import { describe, expect, it, vi } from 'vitest';

import { AppServerHost } from './host.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { Transport, LineHandler, StderrHandler, CloseHandler } from './transport.js';

/** 任何请求都永不回应的 transport — 模拟远端 daemon bootstrap 挂死 / SSH 通道无响应。 */
class HangingTransport implements Transport {
  private readonly closeHandlers = new Set<CloseHandler>();

  async writeLine(_line: string): Promise<void> {
    // 请求照收, 永远不回 response → initialize 挂起。
  }

  onLine(_handler: LineHandler): () => void {
    return () => {};
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onStderr(_handler: StderrHandler): () => void {
    return () => {};
  }

  async close(reason = 'test close'): Promise<void> {
    for (const handler of this.closeHandlers) handler({ reason });
  }
}

/** 所有请求延迟 respondDelayMs 回应的 transport — initialize 最终能完成。 */
class DelayedTransport implements Transport {
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();

  constructor(private readonly respondDelayMs: number) {}

  async writeLine(line: string): Promise<void> {
    const msg = JSON.parse(line) as { id?: unknown };
    if (msg.id == null) return; // notification (initialized 等), 无 response
    setTimeout(() => {
      const result = {
        userAgent: 'mock-codex/test',
        codexHome: '/tmp/codex-home',
        platformOs: 'linux',
      };
      for (const handler of this.lineHandlers) handler(JSON.stringify({ id: msg.id, result }));
    }, this.respondDelayMs);
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onStderr(_handler: StderrHandler): () => void {
    return () => {};
  }

  async close(reason = 'test close'): Promise<void> {
    for (const handler of this.closeHandlers) handler({ reason });
  }
}

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
};

describe('AppServerHost.request startup timeout', () => {
  it('bounds a hung ensureStarted by the caller-provided timeoutMs (greptile R6 P1)', async () => {
    // 冷启动 / transport 重建时 ensureStarted 本身也可能永不返回 — 调用方显式
    // 给的 timeoutMs 必须同样覆盖启动路径, 否则「关键 RPC 加超时」形同虚设。
    const host = new AppServerHost({
      createTransport: () => new HangingTransport(),
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });

    await expect(host.request('turn/start', {}, { timeoutMs: 50 })).rejects.toThrow(
      'app-server startup (for turn/start) timed out after 50ms',
    );

    await host.shutdown();
  });

  it('keeps the in-flight bootstrap reusable for a later request after a startup timeout', async () => {
    // 超时只截断本次等待 — bootstrap 仍在后台继续 (startPromise 保留),
    // 后续 request 直接复用, 不重新 spawn。
    const createTransport = vi.fn(() => new DelayedTransport(60));
    const host = new AppServerHost({
      createTransport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });

    await expect(host.request('turn/start', {}, { timeoutMs: 20 })).rejects.toThrow(
      /app-server startup.*timed out/,
    );

    // 后台 bootstrap (60ms) 完成后, 同一个 startPromise 直接可用。
    await expect(host.request('turn/start', {}, { timeoutMs: 1_000 })).resolves.toMatchObject({
      userAgent: 'mock-codex/test',
    });
    expect(createTransport).toHaveBeenCalledTimes(1);

    await host.shutdown();
  });

  it('treats timeoutMs as an overall deadline across startup + request (copilot R9)', async () => {
    // timeoutMs 不是「startup 一次 + request 再一次」的双重施加: startup 用掉
    // 的预算要从 request 里扣, 最坏等待仍是 1× timeoutMs — 否则 60s 关键 RPC
    // 在冷启动路径上最坏拖到 ~120s, UI 长时间卡 generating。
    // DelayedTransport(40): startup ~40ms, 预算 50ms → request 只剩 ~10ms。
    // 1× 语义 ~50ms 超时; 2× 语义要 ~90ms (40 + 50) 才超时。
    const host = new AppServerHost({
      createTransport: () => new DelayedTransport(40),
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });

    const startedAt = Date.now();
    await expect(host.request('turn/start', {}, { timeoutMs: 50 })).rejects.toThrow(
      /timed out after \d+ms|consumed the entire/,
    );
    expect(Date.now() - startedAt).toBeLessThan(70);

    await host.shutdown();
  });
});

describe('AppServerHost.ensureStartedWithTimeout', () => {
  it('rejects when startup hangs past the budget and keeps the shared bootstrap reusable (codex R13 P1)', async () => {
    // startSession 的 initialize 直调与 request() 的 startup deadline 同款语义:
    // 超时只截断本次等待, startPromise 后台继续, 后续调用直接复用不重新 spawn。
    const createTransport = vi.fn(() => new DelayedTransport(60));
    const host = new AppServerHost({
      createTransport,
      logger,
      clientInfo: { name: 'cindy-test', version: '0.0.0' },
    });

    await expect(host.ensureStartedWithTimeout(20, 'startSession initialize')).rejects.toThrow(
      'app-server startup (for startSession initialize) timed out after 20ms',
    );

    // 后台 bootstrap (60ms) 完成后, 同一个 startPromise 直接可用。
    await expect(host.ensureStartedWithTimeout(1_000, 'startSession initialize')).resolves.toMatchObject({
      userAgent: 'mock-codex/test',
    });
    expect(createTransport).toHaveBeenCalledTimes(1);

    await host.shutdown();
  });
});
