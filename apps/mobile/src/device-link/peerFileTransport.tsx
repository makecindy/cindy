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
import { useDeviceLink } from "./DeviceLinkContext";
import {
  DEVICE_LINK_API_BASE_URL,
  getActiveMobileSessionRealm,
} from "@/config/env";

import {
  installPeerFileDownload,
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
      const timer = setTimeout(
        () => {
          pending.current.delete(id);
          reject(new Error("FILE_PEER_TIMEOUT"));
        },
        action === "receive" ? 600_000 : 15000,
      );
      pending.current.set(id, { resolve, reject, timer });
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
  useEffect(() => () => clearPeerMedia(), [account]);
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
    let connection: { id: string; remote: string; device: string } | null =
      null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(idle);
      const old = connection;
      connection = null;
      if (old && current()) {
        void command("close", [old.id]).catch(() => {});
        void link
          .invoke(old.device, FILE_PEER_CHANNEL, [
            { action: "close", connection: old.remote },
          ])
          .catch(() => {});
      }
    };
    const transfer = async (
      device: string,
      url: string,
      signal?: AbortSignal,
    ): Promise<LocalMedia | null> => {
      if (!current() || signal?.aborted) throw new Error("FILE_PEER_CANCELLED");
      if (busy) return null;
      busy = true;
      if (connection && connection.device !== device) close();
      clearTimeout(idle);
      const id = connection?.id ?? randomUUID();
      let remote = connection?.remote,
        target: File | undefined,
        complete = false;
      const cancel = () => {
        if (current()) void command("close", [id]).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      const invoke = (request: unknown) =>
        link.invoke<unknown>(device, FILE_PEER_CHANNEL, [request]);
      try {
        await link.openLink(device);
        if (!remote) {
          const caps = (await invoke({ action: "caps" })) as {
            version?: number;
          };
          if (!current() || signal?.aborted)
            throw new Error("FILE_PEER_CANCELLED");
          if (caps?.version !== 1) return null;
          const servers = await resolveDesktopIceServers(() =>
            auth.apiFetch(REMOTE_DESKTOP_ICE_CONFIG_PATH, {
              baseUrl: DEVICE_LINK_API_BASE_URL,
              timeoutMs: REMOTE_DESKTOP_ICE_CONFIG_TIMEOUT_MS,
              cache: "no-store",
            }),
          );
          if (!current() || signal?.aborted)
            throw new Error("FILE_PEER_CANCELLED");
          const sdp = await command("offer", [id, servers]);
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
          await command("answer", [id, answer.sdp]);
          connection = { id, remote, device };
        }
        const file = parseFilePeerFile(
          await invoke({ action: "open", connection: remote, url }),
        );
        if (!current() || signal?.aborted) throw new Error("FILE_PEER_CLOSED");
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
        )
          return null;
        target = undefined;
        complete = true;
        return result;
      } catch {
        if (!current() || signal?.aborted)
          throw new Error("FILE_PEER_CANCELLED");
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
          if (current()) void command("close", [id]).catch(() => {});
          if (remote && current())
            void invoke({ action: "close", connection: remote }).catch(
              () => {},
            );
        }
      }
    };
    const unregister = installPeerFileDownload(transfer);
    return () => {
      close();
      ++epoch.current;
      unregister();
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
      view.current?.injectJavaScript("if (typeof runtime !== 'undefined') runtime.dispose();true;");
    };
  }, [foreground, ready, auth.isAuthenticated, viewKey]);
  const handleProcessTerminated = () => {
    if (liveView.current !== viewKey) return;
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
            if (event.nativeEvent.data.length > 140000) return;
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
