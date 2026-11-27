/**
 * Raw-stdio plugin process → ACP line transport (docs/plans/acp-plugin-bridge.md).
 * No Electron dependencies, so it is testable in plain Node.
 */

import { AcpLineDecoder, type AcpLineTransport, type AcpTransportClosed, type Logger } from '@cindy/maker-core';
import { GHOST_NODE_STDIO_B64_MAX_CHARS } from '../../shared/ghost.js';
import type { NodeWorkerProcess } from '../cindy-brain/nodeRuntimeBroker.js';

const STDERR_TAIL_CHARS = 4_096;
const CLOSE_STEP_MS = 3_000;

const activityByInstance = new Map<string, Set<() => boolean>>();

export function hasActivePluginEngineWork(instanceId: string): boolean {
  for (const probe of activityByInstance.get(instanceId) ?? []) {
    if (probe()) return true;
  }
  return false;
}

/** Signals the endpoint to stop: stdin EOF, then terminate, then force-kill. */
function waitForExit(exited: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Adapts a raw-stdio plugin process (stdin takes base64 chunks, stdout is a byte
 * stream) to the ACP line transport. `close()` resolves only after the process
 * exited, which Maker treats as the exit proof for startup cleanup.
 */
export function createAcpProcessTransport(
  proc: NodeWorkerProcess,
  logger: Logger,
  instanceId?: string,
): AcpLineTransport {
  let activityProbe: (() => boolean) | undefined;
  const clearActivityProbe = (): void => {
    if (!instanceId || !activityProbe) return;
    const probes = activityByInstance.get(instanceId);
    probes?.delete(activityProbe);
    if (probes?.size === 0) activityByInstance.delete(instanceId);
    activityProbe = undefined;
  };
  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<(info: AcpTransportClosed) => void>();
  let closingByClient = false;
  let closedInfo: AcpTransportClosed | null = null;
  let stderrTail = '';
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => { markExited = resolve; });

  const decoder = new AcpLineDecoder((line) => {
    for (const listener of [...lineListeners]) listener(line);
  });
  const fireClose = (info: AcpTransportClosed): void => {
    if (closedInfo) return;
    closedInfo = info;
    clearActivityProbe();
    const listeners = [...closeListeners];
    closeListeners.clear();
    for (const listener of listeners) listener(info);
  };

  proc.stdout.on('data', (chunk) => {
    try {
      decoder.push(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
    } catch (error) {
      logger.warn('acp endpoint wrote an oversized line; stopping it', { message: String(error) });
      try { proc.kill(); } catch { /* already gone */ }
    }
  });
  proc.stderr.on('data', (chunk) => {
    if (proc.redactStderr) {
      stderrTail = '[REDACTED]';
      return;
    }
    stderrTail = (stderrTail + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))).slice(-STDERR_TAIL_CHARS);
  });
  proc.on('exit', (code, signal) => {
    try { decoder.flush(); } catch { /* partial trailing line */ }
    const detail = `exit ${code ?? 'null'}${signal ? ` ${signal}` : ''}`;
    if (!closingByClient && stderrTail.trim()) {
      // Endpoint diagnostics only (the plugin writes logs to stderr); never stdout payloads.
      logger.warn('acp endpoint exited', { detail, stderrTail: stderrTail.slice(-1_024) });
    }
    fireClose({ reason: closingByClient ? 'closed-by-client' : 'peer-exited', detail });
    markExited();
  });
  proc.on('error', (error) => {
    logger.warn('acp endpoint process error', { message: error.message });
  });

  return {
    setActivityProbe(probe) {
      if (!instanceId || closedInfo) return;
      clearActivityProbe();
      let probes = activityByInstance.get(instanceId);
      if (!probes) activityByInstance.set(instanceId, (probes = new Set()));
      probes.add(probe);
      activityProbe = probe;
    },
    write(line) {
      if (closedInfo || closingByClient || proc.stdin.destroyed) throw new Error('ACP endpoint is not running');
      const encoded = Buffer.from(`${line}\n`, 'utf8').toString('base64');
      // 插件进程按帧收 base64(stdin-b64)，超过 GHOST_NODE_STDIO_B64_MAX_CHARS 的帧会被整段
      // 丢弃：一条 ACP 消息里嵌一张 base64 图片就可能远超上限，那一轮请求会在引擎那侧凭空消失。
      // 上限是 4 的整数倍，按它切段每段仍是合法 base64；接收端依次写进同一条 stdin，
      // 拼接回来与原行逐字节一致，所以引擎仍然只看到一行一条消息。
      if (encoded.length <= GHOST_NODE_STDIO_B64_MAX_CHARS) {
        proc.stdin.write(encoded);
        return;
      }
      for (let offset = 0; offset < encoded.length; offset += GHOST_NODE_STDIO_B64_MAX_CHARS) {
        proc.stdin.write(encoded.slice(offset, offset + GHOST_NODE_STDIO_B64_MAX_CHARS));
      }
    },
    onLine(listener) {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onClose(listener) {
      if (closedInfo) {
        const info = closedInfo;
        queueMicrotask(() => listener(info));
        return () => {};
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    async close() {
      if (closedInfo) return;
      closingByClient = true;
      proc.sendControl?.({ type: 'stdin-end' });
      if (await waitForExit(exited, CLOSE_STEP_MS)) return;
      try { proc.kill(); } catch { /* already gone */ }
      if (await waitForExit(exited, CLOSE_STEP_MS)) return;
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      if (await waitForExit(exited, CLOSE_STEP_MS)) return;
      throw new Error('ACP endpoint did not exit');
    },
  };
}
