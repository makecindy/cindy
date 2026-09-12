import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type {
  RemoteDesktopCapabilities,
  RemoteDesktopLease,
  RemoteDesktopRequest,
} from "@cindy/device-link";
import { remotePresentation } from "../../modules/cindy-remote-presentation/src";
import { useRemoteDesktopPreference } from "./useLockOnExitPreference";
import {
  ClipboardSync,
  type ClipboardSyncBaseline,
  type LocalClipboardReadCache,
} from "./clipboardSync";
import { clipboardSyncFailure } from "./clipboardSyncFailure";

// One phone-local version/digest, memory only; no clipboard text or permission grant.
const localReadCache: LocalClipboardReadCache = {};

export function useRemoteDesktopSafety(
  deviceId: string,
  lease: RemoteDesktopLease | null,
  connected: boolean,
  focused: boolean,
  caps: RemoteDesktopCapabilities | null,
  request: <T>(
    message: RemoteDesktopRequest,
    preSend?: () => void,
  ) => Promise<T>,
  lockOnExit = false,
) {
  const [privacy, setPrivacy, privacyLoaded] = useRemoteDesktopPreference(
    deviceId,
    "privacy-screen",
    false,
  );
  const [sync, setSync, syncLoaded] = useRemoteDesktopPreference(
    deviceId,
    "clipboard-sync",
    false,
  );
  const [hostMute, setHostMute, hostMuteLoaded] = useRemoteDesktopPreference(
    deviceId,
    "host-mute",
    false,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const [privacyActive, setPrivacyActive] = useState(false);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, []);
  const latest = useRef({ lease, sync, focused, connected });
  latest.current = { lease, sync, focused, connected };
  const syncSupported =
    caps?.clipboardSync === true &&
    !!remotePresentation?.clipboardVersion &&
    !!remotePresentation?.syncClipboard &&
    !!remotePresentation?.readClipboard;
  const syncBaseline = useRef<{
    deviceId: string;
    value: ClipboardSyncBaseline;
  }>({
    deviceId,
    value: { local: "", remote: "" },
  });
  // Foreground/control/lease changes pause synchronization, not copy history.
  // Explicit opt-out and changing computers start a fresh baseline.
  useEffect(() => {
    if (!sync || syncBaseline.current.deviceId !== deviceId)
      syncBaseline.current = { deviceId, value: { local: "", remote: "" } };
    setClipboardNotice(null);
  }, [deviceId, sync]);
  useEffect(() => {
    console.debug("[clipboard-sync] state", {
      enabled: sync,
      loaded: syncLoaded,
      supported: syncSupported,
      connected,
      controlling: lease?.controlling === true,
      focused,
      foreground,
    });
  }, [
    sync,
    syncLoaded,
    syncSupported,
    connected,
    lease?.controlling,
    focused,
    foreground,
  ]);
  useEffect(() => {
    setPrivacyActive(false);
    if (!lease || !connected || !privacyLoaded || !caps?.privacyScreen) return;
    let current = true;
    setNotice(null);
    const check = () => {
      if (!current) throw new Error("DESKTOP_LEASE_EXPIRED");
    };
    void request<{ enabled: boolean }>(
      { op: "privacyScreen", lease: lease.lease, enabled: privacy, lockOnExit },
      check,
    )
      .then((result) => {
        if (current) setPrivacyActive(result.enabled);
      })
      .catch(() => {
        if (current) setNotice("privacyFailed");
      });
    return () => {
      current = false;
    };
  }, [
    lease?.lease,
    connected,
    privacy,
    privacyLoaded,
    lockOnExit,
    caps?.privacyScreen,
    request,
  ]);
  useEffect(() => {
    if (!lease || !connected || !hostMuteLoaded || caps?.hostMute !== true)
      return;
    let current = true;
    void request({
      op: "hostMute",
      lease: lease.lease,
      enabled: hostMute,
    }).catch(() => {
      if (current) setNotice("hostMuteFailed");
    });
    return () => {
      current = false;
    };
  }, [
    lease?.lease,
    connected,
    hostMute,
    hostMuteLoaded,
    caps?.hostMute,
    request,
  ]);
  useEffect(() => {
    if (
      !lease ||
      !connected ||
      !lease.controlling ||
      !focused ||
      !foreground ||
      !sync ||
      !syncLoaded ||
      !syncSupported
    )
      return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () =>
      current &&
      latest.current.lease?.lease === lease.lease &&
      latest.current.lease.controlling &&
      latest.current.connected &&
      latest.current.sync &&
      latest.current.focused &&
      AppState.currentState === "active";
    const check = () => {
      if (!valid()) throw new Error("DESKTOP_LEASE_EXPIRED");
    };
    const guardedRequest = <T>(message: RemoteDesktopRequest) =>
      request<T>(message, check);
    console.debug("[clipboard-sync] started");
    const engine = new ClipboardSync(
      {
        lease: lease.lease,
        current: valid,
        inline: caps?.clipboardInline === true,
        localReadCache,
        trace: (stage) => {
          console.debug("[clipboard-sync] progress", { stage });
          if (!valid()) return;
          if (stage === "content-skipped")
            setClipboardNotice("clipboardSyncSkipped");
          if (
            stage === "phone-to-computer-complete" ||
            stage === "computer-to-phone-complete"
          )
            setClipboardNotice(null);
        },
        request: guardedRequest,
        localVersion: () => remotePresentation!.clipboardVersion!(),
        readLocal: () => remotePresentation!.readClipboard!(),
        writeLocal: (json, version) =>
          remotePresentation!.syncClipboard!(json, version),
      },
      syncBaseline.current.value,
    );
    let enabledOnHost = false;
    let failures = 0;
    const run = async () => {
      try {
        if (!enabledOnHost) {
          await guardedRequest({
            op: "clipboardSync",
            lease: lease.lease,
            enabled: true,
          });
          check();
          enabledOnHost = true;
        }
        await engine.tick();
        if (valid())
          setClipboardNotice((value) =>
            value === "clipboardSyncFailed" ||
            value === "clipboardSyncPermission"
              ? null
              : value,
          );
        failures = 0;
        if (valid()) timer = setTimeout(() => void run(), 1500);
      } catch (error) {
        if (!valid()) return;
        const failure = clipboardSyncFailure(error, failures++);
        console.debug("[clipboard-sync] failed", {
          stage: enabledOnHost ? "transfer" : "enable",
          code: failure.code,
        });
        setClipboardNotice(failure.notice);
        // Permission errors wait for a deliberate retry; transient failures use
        // bounded backoff. Neither path writes the user's persisted preference.
        if (failure.delay !== null)
          timer = setTimeout(() => void run(), failure.delay);
      }
    };
    void run();
    return () => {
      console.debug("[clipboard-sync] paused");
      current = false;
      clearTimeout(timer);
      void request({
        op: "clipboardSync",
        lease: lease.lease,
        enabled: false,
      }).catch(() => {});
    };
  }, [
    deviceId,
    lease?.lease,
    lease?.controlling,
    connected,
    focused,
    foreground,
    sync,
    syncLoaded,
    syncSupported,
    caps?.clipboardInline,
    syncAttempt,
    request,
    setSync,
  ]);
  return {
    privacy,
    privacyActive,
    privacyAvailable: privacyLoaded && caps?.privacyScreen === true,
    onPrivacy: setPrivacy,
    clipboardSync: sync,
    clipboardSyncAvailable: syncLoaded && syncSupported,
    onClipboardSync: setSync,
    onClipboardSyncRetry: () => {
      syncBaseline.current = { deviceId, value: { local: "", remote: "" } };
      setClipboardNotice(null);
      setSyncAttempt((value) => value + 1);
    },
    hostMute,
    hostMuteAvailable: hostMuteLoaded && caps?.hostMute === true,
    onHostMute: async (enabled: boolean) => {
      setHostMute(enabled);
      if (!lease || !connected || caps?.hostMute !== true) return;
      try {
        await request({ op: "hostMute", lease: lease.lease, enabled });
      } catch {
        setHostMute(!enabled);
        setNotice("hostMuteFailed");
      }
    },
    safetyNotice: clipboardNotice ?? notice,
  };
}
