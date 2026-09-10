import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { REMOTE_DESKTOP_CHANNEL } from "@cindy/device-link";
import { useAuth } from "@/auth/AuthContext";
import { ensureDeviceId } from "@/auth/deviceId";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { getActiveMobileSessionRealm } from "@/config/env";
import { useTheme } from "@/theme";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { remoteCredentials as native } from "../../modules/cindy-remote-credentials/src";
import { configureCredentialIdentity } from "./credentialIdentity";
import { credentialStep } from "./credentialDiagnostics";
import {
  credentialErrorKey,
  RemoteDesktopCredentialSession,
} from "./credentialSession";

const defaults = {
  autoUnlock: false,
  biometricVerification: false,
  biometricAvailable: true,
  biometricPreferred: true,
};

export function useAutoUnlockSettings(target: string, active = true) {
  const auth = useAuth(),
    link = useDeviceLink();
  const { t, i18n } = useTranslation(),
    { mode } = useTheme();
  const [settings, setSettings] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const available = Boolean(
    native?.savedUnlockSettings &&
    native.beginUnlock &&
    native.forgetSavedUnlock &&
    native.setSavedUnlockBiometric,
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  const activeTarget = useRef(target);
  activeTarget.current = target;
  const mounted = useRef(true),
    pending = useRef(false),
    attempted = useRef(false);
  const epoch = useRef(0);
  const transaction = useRef<RemoteDesktopCredentialSession | null>(null);
  const owner = getMobileAuthOwner();
  useEffect(() => {
    mounted.current = true;
    epoch.current++;
    pending.current = false;
    setBusy(false);
    attempted.current = false;
    setSettings(defaults);
    setNotice(null);
    if (active)
      void read().catch(() => {
        if (mounted.current)
          setNotice(t("remoteDesktop.autoUnlockUnavailable"));
      });
    return () => {
      mounted.current = false;
      epoch.current++;
      transaction.current?.close();
    };
  }, [target, owner.generation, available, active]);

  async function scope() {
    const generation = epoch.current;
    const currentOwner = getMobileAuthOwner(),
      realm = getActiveMobileSessionRealm();
    const check = () => {
      if (
        !activeRef.current ||
        !mounted.current ||
        generation !== epoch.current ||
        activeTarget.current !== target ||
        !isMobileAuthOwnerCurrent(currentOwner)
      )
        throw new Error("CREDENTIAL_CANCELLED");
    };
    const device = await ensureDeviceId();
    check();
    return {
      args: [realm, currentOwner.accountId, device, target] as const,
      check,
    };
  }
  async function read() {
    if (!available) return defaults;
    const current = await scope();
    const value = await credentialStep("read-settings", () =>
      native!.savedUnlockSettings!(...current.args),
    );
    current.check();
    const confirmed = { ...defaults, ...value };
    setSettings(confirmed);
    return confirmed;
  }
  async function authenticate(
    setup: boolean,
    biometric: boolean,
    requestBiometric = false,
  ) {
    const current = await credentialStep("scope", scope),
      token = await credentialStep("access-token", () => auth.getAccessToken());
    current.check();
    if (!token) throw new Error("CREDENTIAL_INVALID_IDENTITY");
    const invoke: typeof link.invoke = (...args) => {
      current.check();
      return link.invoke(...args);
    };
    await credentialStep("open-link", () => link.openLink(target));
    current.check();
    const ready = await credentialStep("host-prepare", () =>
      invoke<{ version: number; ready: boolean; descriptor: string }>(
        target,
        REMOTE_DESKTOP_CHANNEL,
        [{ op: "credential", version: 1, kind: "prepare", setup }],
        { preSend: current.check },
      ),
    );
    current.check();
    if (
      ready?.version !== 1 ||
      !ready.ready ||
      typeof ready.descriptor !== "string"
    )
      throw new Error("CREDENTIAL_UNAVAILABLE");
    await credentialStep("phone-configure", () =>
      configureCredentialIdentity(token),
    );
    current.check();
    const session = new RemoteDesktopCredentialSession();
    transaction.current = session;
    try {
      await session.ensure(target, invoke, i18n.language, mode, {
        setup,
        biometric,
        descriptor: ready.descriptor,
      });
      current.check();
      if (setup) {
        // Password validation and storage must finish before asking for Face ID.
        const saved = await read();
        current.check();
        if (
          requestBiometric &&
          saved.autoUnlock &&
          !saved.biometricVerification &&
          saved.biometricAvailable
        ) {
          await credentialStep("enable-face-id", () =>
            native!.setSavedUnlockBiometric!(
              ...current.args,
              true,
              i18n.language,
            ),
          );
          current.check();
        }
      }
    } finally {
      session.close();
      if (transaction.current === session) transaction.current = null;
    }
  }
  async function change(action: () => Promise<void>) {
    if (pending.current) return;
    const generation = epoch.current;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await read();
    } catch (error) {
      if (
        mounted.current &&
        generation === epoch.current &&
        activeTarget.current === target
      )
        setNotice(
          t(
            `remoteDesktop.${credentialErrorKey(error) === "credentialRequired" ? "autoUnlockUnavailable" : credentialErrorKey(error)}`,
          ),
        );
    } finally {
      if (generation === epoch.current) {
        pending.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }
  return {
    ...settings,
    busy,
    available,
    notice,
    onAutoUnlock: (enabled: boolean) => {
      void change(async () => {
        if (enabled) {
          if (settings.autoUnlock) return;
          const previous = await read();
          await authenticate(true, false, previous.biometricPreferred);
        } else {
          const current = await scope();
          await native!.forgetSavedUnlock!(...current.args);
          current.check();
        }
      });
    },
    onBiometricVerification: (enabled: boolean) => {
      void change(async () => {
        const current = await scope();
        await credentialStep("change-face-id", () =>
          native!.setSavedUnlockBiometric!(
            ...current.args,
            enabled,
            i18n.language,
          ),
        );
        current.check();
      });
    },
    // A deliberate new connection may try again; media retries and iOS
    // inactive transitions (including Face ID) retain attempt suppression.
    resetConnectionAttempt: () => {
      attempted.current = false;
    },
    maybeUnlock: async () => {
      if (!available || attempted.current || pending.current) return;
      try {
        const saved = await read();
        if (!saved.autoUnlock) return;
        const current = await scope();
        const status = await link.invoke<{ version: number; state: string }>(
          target,
          REMOTE_DESKTOP_CHANNEL,
          [{ op: "credential", version: 1, kind: "status" }],
          { preSend: current.check },
        );
        current.check();
        if (status?.version !== 1 || status.state !== "locked") return;
        attempted.current = true;
        await change(() => authenticate(false, saved.biometricVerification));
      } catch {
        if (mounted.current)
          setNotice(t("remoteDesktop.autoUnlockUnavailable"));
      }
    },
  };
}
