import { canStagePeerMedia } from "./peerFileRegistry";
import {
  createFileReadQueue,
  createPeerTransferCooldown,
  createFileTransferWatchdog,
  fileTransferPath,
  filePeerReuseMs,
  FILE_PEER_WRITE_BATCH_BYTES,
  FILE_PEER_COMMAND_TIMEOUT_MS,
  FILE_PEER_RECEIVE_TIMEOUT_MS,
  FILE_PEER_PROGRESS_SAMPLE_MS,
  type FileTransferPath,
  canUsePeerInvoke,
  uploadPeerAttachment,
  canSendPeerAttachment,
  type InvokeResultPayload,
} from "@cindy/device-link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPeerFileCache } from './peerFileCache';
import { AppState, View } from "react-native";
import { WebView } from "react-native-webview";
import { Directory, File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import {
  FILE_PEER_RUNTIME_SOURCE,
  FILE_PEER_CHANNEL,
  parseFilePeerFile,
  resolveDesktopIceServers,
  REMOTE_DESKTOP_ICE_CONFIG_PATH,
  REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
} from "@cindy/device-link";
import { useAuth } from "@/auth/AuthContext";
import { errorText, nextFileTrace } from "@/debug/fileDiagnostics";
import { mobileDebugEnabled, mobileDebugLog } from "@/debug/mobileDebugLog";
import { useDeviceLink } from "./DeviceLinkContext";
import {
  DEVICE_LINK_API_BASE_URL,
  getActiveMobileSessionRealm,
} from "@/config/env";

import {
  installPeerFileDownload,
  installPeerInvoke,
  installPeerUpload,
  installPeerUploadProbe,
  installPeerReset,
  recordPeerMedia,
  peerMediaUri,
  releasePeerMedia,
  clearPeerMedia,
  type LocalPeerMedia as LocalMedia,
} from "./peerFileRegistry";

let swept = false;
const origin = "https://cindy-file-peer.invalid";
/** Active transfers refresh route information once per interval. */
const PROGRESS_SAMPLE_MS = FILE_PEER_PROGRESS_SAMPLE_MS;
/**
 * Route/diagnostics probe budget, independent of the generic 15s command timeout: a stalled
 * runtime.stats() voids one sample only and never blocks later sampling ticks.
 */
const PROBE_BUDGET_MS = 5000;
/** Runtime stats are counters and candidate kinds only; unparsable replies stay out of logs. */
function parseTransportStats(raw: unknown): unknown {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none';"><script>
const pending=new Map();let seq=0;
function call(type,args){return new Promise((resolve,reject)=>{const id=String(++seq);pending.set(id,{resolve,reject});window.ReactNativeWebView.postMessage(JSON.stringify({type,id,args}));});}
${FILE_PEER_RUNTIME_SOURCE}
const runtime=CindyFilePeerRuntime.createFilePeerRuntime({read:()=>Promise.reject(new Error('denied')),write:(...args)=>call('write',args),writeBatch:(...args)=>call('write',args),closed:connection=>window.ReactNativeWebView.postMessage(JSON.stringify({type:'closed',connection}))});
window.filePeerMessage=async function(m){
 if(m.type==='writeReply'){const p=pending.get(m.id);if(p){pending.delete(m.id);m.ok?p.resolve():p.reject(new Error('write'));}return;}
 try{const result=await runtime[m.action](...m.args);window.ReactNativeWebView.postMessage(JSON.stringify({type:'reply',id:m.id,ok:true,result}));}
 catch{window.ReactNativeWebView.postMessage(JSON.stringify({type:'reply',id:m.id,ok:false}));}
};
window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
</script>`;

/** A trusted data-only WebView; user preview documents never receive this bridge. */
export function PeerFileTransport() {
  const auth = useAuth(),
    link = useDeviceLink();
  const view = useRef<WebView>(null);
  const peerClosed = useRef<((id: string) => void) | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [ready, setReady] = useState<string | null>(null);
  const [crashes, setCrashes] = useState(0);
  const pending = useRef(
    new Map<
      string,
      {
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
        action: string;
        connection: unknown;
        refresh?(): void;
      }
    >(),
  );
  const sinks = useRef(
    new Map<
      string,
      { handle: ReturnType<File["open"]>; size: number; offset: number; onProgress?: (loaded: number, total: number) => void }
    >(),
  );
  const epoch = useRef(0);
  const cooldown = useRef(createPeerTransferCooldown());
  const cacheOwner = JSON.stringify([getActiveMobileSessionRealm(), auth.user?.id]);
  const fileCache = useMemo(() => createPeerFileCache(cacheOwner).catch(() => null), [cacheOwner]);
  const account = `${auth.user?.id ?? ""}:${getActiveMobileSessionRealm()}:${auth.isAuthenticated}:${auth.accountGeneration}`;
  // Epoch advances on reconnect; status also invalidates work at disconnect.
  const owner = `${account}:${link.connectionEpoch}:${link.status}`;
  const enabled = foreground && auth.isAuthenticated && link.status === "online";
  const viewKey = `${owner}:${crashes}`;
  const liveView = useRef(viewKey);
  liveView.current = viewKey;
  function send(message: unknown) {
    view.current?.injectJavaScript(
      `window.filePeerMessage(${JSON.stringify(message)});true;`,
    );
  }
  async function command(action: string, args: unknown[], timeoutMs?: number) {
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      let timer = setTimeout(
        () => {
          pending.current.delete(id);
          reject(new Error("FILE_PEER_TIMEOUT"));
        },
        action === "receive"
          ? FILE_PEER_RECEIVE_TIMEOUT_MS
          : action === 'stats' ? PROBE_BUDGET_MS
          : timeoutMs && timeoutMs > FILE_PEER_COMMAND_TIMEOUT_MS
            ? timeoutMs
            : FILE_PEER_COMMAND_TIMEOUT_MS,
      );
      const entry = {
        resolve,
        reject,
        timer,
        action,
        connection: args[0],
        refresh:
          action === "receive"
            ? () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                  pending.current.delete(id);
                  reject(new Error("FILE_PEER_TIMEOUT"));
                }, FILE_PEER_RECEIVE_TIMEOUT_MS);
                entry.timer = timer;
              }
            : undefined,
      };
      pending.current.set(id, entry);
      send({ id, action, args });
    });
  }
  function rejectReceive(connection: string, reason: string) {
    for (const [id, operation] of pending.current) {
      if (operation.action !== 'receive' || operation.connection !== connection) continue;
      pending.current.delete(id);
      clearTimeout(operation.timer);
      operation.reject(new Error(reason));
    }
  }
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (s) => {
      setForeground(s === "active");
      if (s !== "active") setReady(null);
    });
    return () => subscription.remove();
  }, []);
  // Completed files outlive transport reconnects/backgrounding, but never an account switch.
  useEffect(
    () => () => {
      clearPeerMedia();
      cooldown.current.clear();
    },
    [account],
  );
  useEffect(() => {
    if (!enabled || ready !== viewKey) return;
    if (!swept) {
      swept = true;
      const dir = new Directory(Paths.cache, "remote-media-share", "file-peer");
      try {
        if (dir.exists)
          for (const entry of dir.list())
            if (entry instanceof File && /^[a-f0-9-]{36}$/.test(entry.name)) {
              try {
                entry.delete();
              } catch {}
            }
      } catch {
        /* Cache IO must not prevent the OSS fallback. */
      }
    }
    const generation = ++epoch.current;
    const current = () =>
      epoch.current === generation &&
      liveView.current === viewKey &&
      AppState.currentState === "active";
    let busy = false;
    const deviceGenerations = new Map<string, object>();
    const captureDevice = (device: string) => {
      const generation = deviceGenerations.get(device);
      return () => current() && deviceGenerations.get(device) === generation;
    };
    let connection: {
      id: string;
      remote: string;
      device: string;
      rpc: boolean;
      attachments: boolean;
      /** 电脑端直连附件不设固定上限;旧版电脑会拒收超过 OSS 上限的附件。 */
      largeAttachments: boolean;
      path: FileTransferPath;
      reuseMs: number | null;
    } | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const close = (notify = true) => {
      clearTimeout(idle);
      const old = connection;
      connection = null;
      if (old) {
        if (current()) void command("close", [old.id]).catch(() => {});
        // Backgrounding must release the host too, while the existing WSS is alive.
        if (notify && epoch.current === generation && liveView.current === viewKey)
          void link
            .invoke(old.device, FILE_PEER_CHANNEL, [
              { action: "close", connection: old.remote },
            ])
            .catch(() => {});
      }
    };
    const scheduleIdle = () => {
      clearTimeout(idle);
      if (connection && connection.reuseMs !== null) idle = setTimeout(close, connection.reuseMs);
    };
    peerClosed.current = (id) => {
      if (connection?.id !== id) return;
      close();
      for (const [key, p] of pending.current) {
        if (p.connection !== id) continue;
        pending.current.delete(key);
        clearTimeout(p.timer);
        p.reject(new Error('FILE_PEER_UNAVAILABLE'));
      }
    };
    const transportCurrent = current;
    const unregisterReset = installPeerReset((device) => {
      deviceGenerations.set(device, {});
      if (connection?.device === device) close(false);
    });
    const transfer = async (
      device: string,
      url: string | null,
      signal?: AbortSignal,
      readTrace?: number,
      onProgress?: (loaded: number, total: number) => void,
    ): Promise<LocalMedia | null> => {
      const current = captureDevice(device);
      // Keep a device close from turning into an upload fallback or reopening its link.
      if (!current() || signal?.aborted) throw new Error("FILE_PEER_CANCELLED");
      const trace = readTrace || nextFileTrace();
      const remaining = cooldown.current.remaining(device);
      if (remaining) {
        mobileDebugLog("debug", "files", "direct transfer skipped", {
          trace,
          reason: "cooldown",
          remainingMs: remaining,
        });
        return null;
      }
      if (busy) {
        mobileDebugLog("debug", "files", "direct transfer skipped", {
          trace,
          reason: "busy",
        });
        return null;
      }
      busy = true;
      const startedAt = Date.now();
      let step = "link";
      let received = 0;
      // Latest in-flight sample, attached to the outcome log of slow transfers.
      let lastProgress: Record<string, unknown> | undefined;
      // Distinguishes a transport/view reset (no upload fallback) from ordinary failures.
      const cancelReason = () =>
        signal?.aborted
          ? "aborted"
          : epoch.current !== generation
            ? "runtime-reset"
            : liveView.current !== viewKey
              ? "connection-changed"
              : AppState.currentState !== "active"
                ? "background"
                : null;
      if (connection && connection.device !== device) close();
      clearTimeout(idle);
      const id = connection?.id ?? randomUUID();
      let remote = connection?.remote,
        target: File | undefined,
        complete = false;
      mobileDebugLog("debug", "files", "direct transfer start", {
        trace,
        reuseConnection: !!remote,
      });
      const cancel = () => {
        rejectReceive(id, 'FILE_PEER_CANCELLED');
        if (current()) void command("close", [id]).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      const invoke = (request: unknown) => {
        if (!current() || signal?.aborted)
          throw new Error("FILE_PEER_CANCELLED");
        return link.invoke<unknown>(device, FILE_PEER_CHANNEL, [request]);
      };
      try {
        await link.openLink(device);
        if (!remote) {
          step = "caps";
          const caps = (await invoke({ action: "caps" })) as {
            version?: number;
            streaming?: boolean;
            attachments?: boolean;
            largeAttachments?: boolean;
            idleMs?: number;
            sessionBound?: boolean;
          };
          if (!current() || signal?.aborted)
            throw new Error("FILE_PEER_CANCELLED");
          if (caps?.version !== 1) {
            cooldown.current.fail(device);
            mobileDebugLog("debug", "files", "direct transfer skipped", {
              trace,
              reason: "host-version",
              version: typeof caps?.version === "number" ? caps.version : null,
            });
            return null;
          }
          step = "ice-config";
          const servers = await resolveDesktopIceServers(
            () =>
              auth.apiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
                baseUrl: DEVICE_LINK_API_BASE_URL,
                timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
                cache: "no-store",
              }),
            (diagnostic) =>
              mobileDebugLog("debug", "files", "direct transfer ice config", {
                trace,
                ...diagnostic,
              }),
          );
          if (!current() || signal?.aborted)
            throw new Error("FILE_PEER_CANCELLED");
          step = "offer";
          const sdp = await command("offer", [
            id,
            servers,
            caps.streaming === true,
          ]);
          step = "host-answer";
          const answer = (await invoke({ action: "offer", sdp,
            ...(caps.sessionBound === true ? { sessionBound: true } : {}),
          })) as {
            connection?: string;
            sdp?: string;
          };
          if (
            !answer ||
            typeof answer.connection !== "string" ||
            !/^[a-f0-9-]{36}$/.test(answer.connection) ||
            typeof answer.sdp !== "string" ||
            answer.sdp.length > 128 * 1024
          )
            throw new Error("FILE_PEER_ANSWER");
          remote = answer.connection;
          if (!current() || signal?.aborted)
            throw new Error("FILE_PEER_CLOSED");
          step = "answer";
          await command("answer", [id, answer.sdp]);
          if (!current() || signal?.aborted) throw new Error('FILE_PEER_CANCELLED');
          connection = {
            id,
            remote,
            device,
            rpc: caps.streaming === true,
            attachments: caps.attachments === true,
            largeAttachments: caps.largeAttachments === true,
            path: 'unknown',
            reuseMs: filePeerReuseMs(caps.idleMs, caps.sessionBound),
          };
          mobileDebugLog("debug", "files", "direct transfer connected", {
            trace,
            ms: Date.now() - startedAt,
          });
        }
        void command('stats', [id]).then((raw) => {
          if (current() && connection?.id === id) connection.path = fileTransferPath(raw);
        }).catch(() => {});
        if (url === null) {
          complete = true;
          cooldown.current.success(device);
          return null;
        }
        step = "open";
        const file = parseFilePeerFile(
          await invoke({ action: "open", connection: remote, url }),
        );
        if (!current() || signal?.aborted) throw new Error("FILE_PEER_CLOSED");
        if (!canStagePeerMedia(file.size, Paths.availableDiskSpace)) {
          mobileDebugLog("debug", "files", "direct transfer skipped", {
            trace,
            reason: "storage",
            size: file.size,
          });
          return null;
        }
        step = "receive";
        const transferStartedAt = Date.now();
        const directory = new Directory(
          Paths.cache,
          "remote-media-share",
          "file-peer",
        );
        directory.create({ intermediates: true, idempotent: true });
        target = new File(directory, randomUUID());
        target.create();
        const handle = target.open();
        sinks.current.set(id, { handle, size: file.size, offset: 0, onProgress });
        try { onProgress?.(0, file.size); } catch { /* UI observers cannot interrupt a transfer. */ }
        // Detect stalled writes even with Debug recording off. Route sampling is
        // diagnostic only; a slow route must not interrupt a progressing download.
        let sampling = false;
        // Set when the receive settles: an already-issued stats reply must not append
        // a progress line behind the outcome log with a dropped sink offset.
        let ended = false;
        const watch = createFileTransferWatchdog();
        let slow = false;
        const sampler = setInterval(() => {
          if (ended || !current()) return;
          const reason = watch(sinks.current.get(id)?.offset ?? 0);
          if (reason && !slow) {
            slow = true;
            mobileDebugLog('debug', 'files', 'slow transfer fallback', { trace, reason, path: connection?.path });
            // Close only this file transport; cancellation is still distinguished below.
            rejectReceive(id, 'FILE_PEER_SLOW');
            void command('close', [id]).catch(() => {});
          }
          if (slow || sampling) return;
          sampling = true;
          // 诊断探针独立短预算：runtime.stats() 卡死只作废本样本（迟到回包同样丢弃），
          // 不让 15s 通用超时占住采样节拍，否则恰好在异常链路上拿不到任何样本。
          let settled = false;
          const budget = setTimeout(() => {
            if (settled) return;
            settled = true;
            sampling = false;
          }, PROBE_BUDGET_MS);
          void command("stats", [id])
            .then((raw) => {
              if (settled || ended) return;
              if (connection?.id === id) connection.path = fileTransferPath(raw);
              if (!mobileDebugEnabled()) return;
              lastProgress = {
                elapsedMs: Date.now() - transferStartedAt,
                written: sinks.current.get(id)?.offset ?? null,
                size: file.size,
                stats: parseTransportStats(raw),
              };
              mobileDebugLog("debug", "files", "direct transfer progress", {
                trace,
                ...lastProgress,
              });
            })
            .catch(() => {})
            .finally(() => {
              if (settled) return;
              settled = true;
              clearTimeout(budget);
              sampling = false;
            });
        }, PROGRESS_SAMPLE_MS);
        try {
          await command("receive", [id, file.ticket, file.size, id]);
          if (
            !current() ||
            signal?.aborted ||
            sinks.current.get(id)?.offset !== file.size
          )
            throw new Error("FILE_PEER_SIZE");
        } finally {
          ended = true;
          clearInterval(sampler);
          received = sinks.current.get(id)?.offset ?? received;
          sinks.current.delete(id);
          try {
            handle.close();
          } catch {}
        }
        const result = { ossKey: "", size: file.size, mimeType: file.mimeType, version: file.version };
        const completed = target;
        if (
          !recordPeerMedia(result, target.uri, () => {
            if (completed.exists) completed.delete();
          })
        ) {
          mobileDebugLog("debug", "files", "direct transfer skipped", {
            trace,
            reason: "staging-budget",
            size: file.size,
          });
          return null;
        }
        target = undefined;
        complete = true;
        cooldown.current.success(device);
        mobileDebugLog("debug", "files", "direct transfer done", {
          trace,
          ms: Date.now() - startedAt,
          size: file.size,
          mime: file.mimeType,
          transferMs: Date.now() - transferStartedAt,
          bytesPerSecond: Math.round(
            (file.size * 1000) / Math.max(1, Date.now() - transferStartedAt),
          ),
          lastProgress,
        });
        return result;
      } catch (error) {
        const cancelled = cancelReason();
        mobileDebugLog("warn", "files", "direct transfer failed", {
          trace,
          step,
          ms: Date.now() - startedAt,
          received,
          error: errorText(error),
          // Non-null means the read is rejected instead of falling back to upload.
          cancelled,
          lastProgress,
        });
        if (!current() || signal?.aborted)
          throw new Error("FILE_PEER_CANCELLED");
        if (step !== "open") cooldown.current.fail(device);
        return null;
      } finally {
        busy = false;
        signal?.removeEventListener("abort", cancel);
        try {
          if (target?.exists) target.delete();
        } catch {
          /* Swept on next process start. */
        }
        if (complete && current()) scheduleIdle();
        else {
          close();
          if (transportCurrent()) void command("close", [id]).catch(() => {});
          // An answer can arrive after background/reset, before connection was
          // assigned. Release that allocation over the same owner/link only;
          // cleanup must not be blocked by the cancelled transfer's guards.
          if (remote && liveView.current === viewKey)
            void link.invoke(device, FILE_PEER_CHANNEL, [
              { action: 'close', connection: remote },
            ]).catch(() => {});
        }
      }
    };
    const queueRead = createFileReadQueue();
    const unregister = installPeerFileDownload(
      (device, url, signal, readTrace, metadata, onProgress) => {
        const active = captureDevice(device);
        return queueRead(
          "connection",
          async () => {
            const check = (result?: LocalMedia | null) => {
              if (active() && !signal?.aborted) return;
              const uri = result && peerMediaUri(result);
              if (uri) releasePeerMedia(uri);
              throw new Error("FILE_PEER_CANCELLED");
            };
            check();
            const cache = await fileCache;
            if (metadata?.skipCache) await cache?.invalidate(device, url).catch(() => undefined);
            const cached = metadata?.skipCache ? null : await cache?.read(device, url, metadata, () => active() && !signal?.aborted).catch(() => null);
            check(cached);
            if (cached) {
              try { onProgress?.(cached.size, cached.size); } catch { /* Observer only. */ }
              mobileDebugLog('debug', 'files', 'file cache hit', { trace: readTrace, size: cached.size });
              return cached;
            }
            if (metadata) await cache?.prune(device, url, metadata.size).catch(() => false);
            check();
            const result = await transfer(device, url, signal, readTrace, onProgress);
            if (result && active() && !signal?.aborted)
              await cache?.store(device, url, metadata, result).catch(() => undefined);
            check(result);
            return result;
          },
          signal,
        );
      },
    );
    // 读整份大文件之前的能力确认:复用已建连接的能力,否则只发一次 caps 查询,不建 WebRTC 连接。
    const unregisterUploadProbe = installPeerUploadProbe(async (device, size) => {
      const current = captureDevice(device);
      if (!current() || cooldown.current.remaining(device)) return false;
      if (connection?.device === device)
        return canSendPeerAttachment(connection, size);
      await link.openLink(device);
      if (!current()) return false;
      const caps = (await link.invoke<unknown>(device, FILE_PEER_CHANNEL, [
        { action: "caps" },
      ])) as {
        version?: number;
        attachments?: boolean;
        largeAttachments?: boolean;
      } | null;
      return (
        current() &&
        caps?.version === 1 &&
        canSendPeerAttachment(
          {
            attachments: caps.attachments === true,
            largeAttachments: caps.largeAttachments === true,
          },
          size,
        )
      );
    });
    const unregisterUpload = installPeerUpload(
      (device, uri, metadata, signal) => {
        const current = captureDevice(device);
        return queueRead(
          "connection",
          async () => {
            const check = () => {
              if (!current() || signal?.aborted)
                throw new Error("FILE_PEER_CANCELLED");
            };
            check();
            if (cooldown.current.remaining(device)) return null;
            let handle: ReturnType<File["open"]> | undefined;
            try {
              await transfer(device, null, signal);
              check();
              const active = connection;
              // 对端不支持(含旧版电脑按 OSS 上限拒收大附件):直接放弃直连,不计入失败冷却。
              if (
                !active ||
                active.device !== device ||
                !canSendPeerAttachment(active, metadata.size)
              )
                return null;
              clearTimeout(idle);
              busy = true;
              handle = new File(uri).open();
              const transferStartedAt = Date.now();
              const result = await uploadPeerAttachment(
                metadata,
                async (offset, length) => {
                  handle!.offset = offset;
                  const bytes = handle!.readBytes(length);
                  if (bytes.length !== length)
                    throw new Error("FILE_PEER_CHANGED");
                  let binary = "";
                  for (const byte of bytes) binary += String.fromCharCode(byte);
                  return btoa(binary);
                },
                async (request, timeoutMs) => {
                  check();
                  const raw = await command(
                    "invoke",
                    [
                      active.id,
                      JSON.stringify({
                        channel: FILE_PEER_CHANNEL,
                        args: [
                          {
                            action: "attachment",
                            connection: active.remote,
                            request,
                          },
                        ],
                      }),
                      timeoutMs,
                    ],
                    timeoutMs,
                  );
                  check();
                  const response = JSON.parse(String(raw));
                  if (!response.ok) throw new Error("FILE_PEER_UPLOAD");
                  return response.result;
                },
                check,
              );
              const ms = Date.now() - transferStartedAt;
              mobileDebugLog("debug", "files", "peer attachment uploaded", {
                bytes: metadata.size,
                transferMs: ms,
                bytesPerSecond: Math.round(
                  (metadata.size * 1000) / Math.max(1, ms),
                ),
              });
              return result;
            } catch {
              check();
              cooldown.current.fail(device);
              return null;
            } finally {
              try {
                handle?.close();
              } catch {}
              busy = false;
              if (current()) scheduleIdle();
            }
          },
          signal,
        );
      },
    );
    const unregisterInvoke = installPeerInvoke(
      async (device, channel, args) => {
        const current = captureDevice(device);
        if (!canUsePeerInvoke(channel, args)) return null;
        if (!current()) throw new Error("FILE_PEER_CANCELLED");
        if (cooldown.current.remaining(device)) return null;
        if (connection?.device !== device || !connection.rpc) {
          return null;
        }
        const id = connection.id;
        clearTimeout(idle);
        try {
          const raw = await command("invoke", [
            id,
            JSON.stringify({ channel, args }),
          ]);
          if (!current()) throw new Error("FILE_PEER_CANCELLED");
          const result = JSON.parse(String(raw)) as InvokeResultPayload;
          if (!result || typeof result.ok !== "boolean")
            throw new Error("FILE_PEER_REPLY");
          return result;
        } catch {
          if (!current()) throw new Error("FILE_PEER_CANCELLED");
          cooldown.current.fail(device);
          // A read can finish after a transfer started, or after another peer replaced it.
          if (!busy && connection?.id === id) close();
          return null;
        } finally {
          if (current() && !busy) scheduleIdle();
        }
      },
    );
    mobileDebugLog("debug", "files", "direct transfer ready");
    return () => {
      mobileDebugLog("debug", "files", "direct transfer reset", {
        busy,
        pendingCommands: pending.current.size,
      });
      close();
      peerClosed.current = null;
      ++epoch.current;
      unregister();
      unregisterInvoke();
      unregisterUpload();
      unregisterUploadProbe();
      unregisterReset();
      for (const p of pending.current.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("FILE_PEER_CLOSED"));
      }
      pending.current.clear();
      for (const sink of sinks.current.values()) {
        try {
          sink.handle.close();
        } catch {}
      }
      sinks.current.clear();
      view.current?.injectJavaScript(
        "if (typeof runtime !== 'undefined') runtime.dispose();true;",
      );
    };
  }, [enabled, ready, viewKey]);
  const handleProcessTerminated = () => {
    if (liveView.current !== viewKey) return;
    mobileDebugLog("warn", "files", "direct transfer runtime terminated", {
      crashes,
    });
    setReady(null);
    setCrashes((n) => Math.min(2, n + 1));
  };
  if (!enabled) return null;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
    >
      <WebView
        ref={view}
        key={viewKey}
        source={{ html, baseUrl: origin }}
        javaScriptEnabled
        originWhitelist={[origin]}
        onShouldStartLoadWithRequest={(r) =>
          r.url === origin || r.url === origin + "/" || r.url === "about:blank"
        }
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        mediaCapturePermissionGrantType="deny"
        incognito
        onContentProcessDidTerminate={handleProcessTerminated}
        onRenderProcessGone={handleProcessTerminated}
        onMessage={(event) => {
          try {
            if (liveView.current !== viewKey) return;
            if (event.nativeEvent.data.length > 8 * 1024 * 1024) return;
            const m = JSON.parse(event.nativeEvent.data);
            if (m.type === "ready") {
              setReady(viewKey);
              return;
            }
            if (m.type === 'closed' && typeof m.connection === 'string') {
              peerClosed.current?.(m.connection);
              return;
            }
            if (m.type === "reply") {
              const p = pending.current.get(m.id);
              if (!p) return;
              pending.current.delete(m.id);
              clearTimeout(p.timer);
              if (m.ok === true) p.resolve(m.result);
              else p.reject(new Error("FILE_PEER_UNAVAILABLE"));
            } else if (m.type === "write") {
              let ok = false;
              try {
                const [id, offset, base64] = m.args;
                const sink = sinks.current.get(id);
                if (
                  !sink ||
                  offset !== sink.offset ||
                  typeof base64 !== "string" ||
                  base64.length > Math.ceil(FILE_PEER_WRITE_BATCH_BYTES / 3) * 4
                )
                  throw new Error();
                const binary = atob(base64),
                  bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
                if (
                  bytes.length > FILE_PEER_WRITE_BATCH_BYTES ||
                  sink.offset + bytes.length > sink.size
                )
                  throw new Error();
                sink.handle.writeBytes(bytes);
                sink.offset += bytes.length;
                try { sink.onProgress?.(sink.offset, sink.size); } catch { /* Observer only. */ }
                for (const operation of pending.current.values())
                  operation.refresh?.();
                ok = true;
              } catch {}
              send({ type: "writeReply", id: m.id, ok });
            }
          } catch {}
        }}
      />
    </View>
  );
}
