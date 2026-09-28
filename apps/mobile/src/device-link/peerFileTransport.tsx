import { canStagePeerMedia } from "./peerFileRegistry";
import {
  createFileReadQueue,
  createPeerTransferCooldown,
  canUsePeerInvoke,
  uploadPeerAttachment,
  type InvokeResultPayload,
} from "@cindy/device-link";
import { useEffect, useRef, useState } from "react";
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
import { mobileDebugLog } from "@/debug/mobileDebugLog";
import { useDeviceLink } from "./DeviceLinkContext";
import {
  DEVICE_LINK_API_BASE_URL,
  getActiveMobileSessionRealm,
} from "@/config/env";

import {
  installPeerFileDownload,
  installPeerInvoke,
  installPeerUpload,
  installPeerReset,
  recordPeerMedia,
  clearPeerMedia,
  type LocalPeerMedia as LocalMedia,
} from "./peerFileRegistry";

let swept = false;
const origin = "https://cindy-file-peer.invalid";
const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none';"><script>
const pending=new Map();let seq=0;
function call(type,args){return new Promise((resolve,reject)=>{const id=String(++seq);pending.set(id,{resolve,reject});window.ReactNativeWebView.postMessage(JSON.stringify({type,id,args}));});}
${FILE_PEER_RUNTIME_SOURCE}
const runtime=CindyFilePeerRuntime.createFilePeerRuntime({read:()=>Promise.reject(new Error('denied')),write:(...args)=>call('write',args)});
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
        refresh?(): void;
      }
    >(),
  );
  const sinks = useRef(
    new Map<
      string,
      { handle: ReturnType<File["open"]>; size: number; offset: number }
    >(),
  );
  const epoch = useRef(0);
  const cooldown = useRef(createPeerTransferCooldown());
  const account = `${auth.user?.id ?? ""}:${getActiveMobileSessionRealm()}:${auth.isAuthenticated}:${auth.accountGeneration}`;
  const owner = `${account}:${link.connectionEpoch}`;
  const viewKey = `${owner}:${crashes}`;
  const liveView = useRef(viewKey);
  liveView.current = viewKey;
  function send(message: unknown) {
    view.current?.injectJavaScript(
      `window.filePeerMessage(${JSON.stringify(message)});true;`,
    );
  }
  async function command(action: string, args: unknown[]) {
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      let timer = setTimeout(
        () => {
          pending.current.delete(id);
          reject(new Error("FILE_PEER_TIMEOUT"));
        },
        action === "receive" ? 60_000 : 15000,
      );
      const entry = {
        resolve,
        reject,
        timer,
        refresh:
          action === "receive"
            ? () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                  pending.current.delete(id);
                  reject(new Error("FILE_PEER_TIMEOUT"));
                }, 60_000);
                entry.timer = timer;
              }
            : undefined,
      };
      pending.current.set(id, entry);
      send({ id, action, args });
    });
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
    if (!foreground || ready !== viewKey || !auth.isAuthenticated) return;
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
    } | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const close = (notify = true) => {
      clearTimeout(idle);
      const old = connection;
      connection = null;
      if (old && current()) {
        void command("close", [old.id]).catch(() => {});
        if (notify)
          void link
            .invoke(old.device, FILE_PEER_CHANNEL, [
              { action: "close", connection: old.remote },
            ])
            .catch(() => {});
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
          const answer = (await invoke({ action: "offer", sdp })) as {
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
          connection = {
            id,
            remote,
            device,
            rpc: caps.streaming === true,
            attachments: caps.attachments === true,
          };
          mobileDebugLog("debug", "files", "direct transfer connected", {
            trace,
            ms: Date.now() - startedAt,
            transport: await command("stats", [id]),
          });
        }
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
        sinks.current.set(id, { handle, size: file.size, offset: 0 });
        try {
          await command("receive", [id, file.ticket, file.size, id]);
          if (
            !current() ||
            signal?.aborted ||
            sinks.current.get(id)?.offset !== file.size
          )
            throw new Error("FILE_PEER_SIZE");
        } finally {
          received = sinks.current.get(id)?.offset ?? received;
          sinks.current.delete(id);
          try {
            handle.close();
          } catch {}
        }
        const result = { ossKey: "", size: file.size, mimeType: file.mimeType };
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
        if (complete && current()) idle = setTimeout(close, 30_000);
        else {
          close();
          if (transportCurrent()) void command("close", [id]).catch(() => {});
          if (remote && current())
            void invoke({ action: "close", connection: remote }).catch(
              () => {},
            );
        }
      }
    };
    const queueRead = createFileReadQueue();
    const unregister = installPeerFileDownload(
      (device, url, signal, readTrace) => {
        const active = captureDevice(device);
        return queueRead(
          "connection",
          () => {
            if (!active()) throw new Error("FILE_PEER_CANCELLED");
            return transfer(device, url, signal, readTrace);
          },
          signal,
        );
      },
    );
    const warming = new Set<string>();
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
              if (!active || active.device !== device || !active.attachments)
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
                async (request) => {
                  check();
                  const raw = await command("invoke", [
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
                  ]);
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
              if (current()) idle = setTimeout(close, 30_000);
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
          if (
            (!connection || connection.device !== device) &&
            !warming.has(device)
          ) {
            warming.add(device);
            void queueRead("connection", () => {
              if (!current()) throw new Error("FILE_PEER_CANCELLED");
              return transfer(device, null);
            })
              .catch(() => {})
              .finally(() => warming.delete(device));
          }
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
          if (current() && !busy) idle = setTimeout(close, 30_000);
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
      ++epoch.current;
      unregister();
      unregisterInvoke();
      unregisterUpload();
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
  }, [foreground, ready, auth.isAuthenticated, viewKey]);
  const handleProcessTerminated = () => {
    if (liveView.current !== viewKey) return;
    mobileDebugLog("warn", "files", "direct transfer runtime terminated", {
      crashes,
    });
    setReady(null);
    setCrashes((n) => Math.min(2, n + 1));
  };
  if (!foreground || !auth.isAuthenticated) return null;
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
                  base64.length > 22000
                )
                  throw new Error();
                const binary = atob(base64),
                  bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
                if (
                  bytes.length > 16384 ||
                  sink.offset + bytes.length > sink.size
                )
                  throw new Error();
                sink.handle.writeBytes(bytes);
                sink.offset += bytes.length;
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
