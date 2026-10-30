import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useTranslation } from "react-i18next";
import {
  desktopPermissionReady,
  type RemoteDesktopPermissions,
  type RemoteDesktopRequest,
} from "@cindy/device-link";
import { PermissionGuideView } from "./PermissionGuideView";

export function PermissionGuide({
  initial,
  request,
  reconnect,
}: {
  initial?: RemoteDesktopPermissions;
  request<T>(message: RemoteDesktopRequest): Promise<T>;
  reconnect(): void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(initial);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!initial)
      return () => {
        mounted.current = false;
      };
    let busy = false;
    const refresh = async () => {
      if (busy || AppState.currentState !== "active") return;
      busy = true;
      try {
        const next = await request<RemoteDesktopPermissions>({
          op: "permissions",
          action: "check",
        });
        if (mounted.current) {
          setStatus(next);
          setNotice((previous) =>
            previous === "permissionCheckFailed" ? null : previous,
          );
        }
      } catch {
        if (mounted.current) setNotice("permissionCheckFailed");
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [initial, request]);
  const guide = async () => {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const next = await request<RemoteDesktopPermissions>({
        op: "permissions",
        action: "guide",
      });
      if (mounted.current) {
        setStatus(next);
        setNotice("permissionGuideOpened");
      }
    } catch {
      if (mounted.current) setNotice("permissionActionFailed");
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const ready =
    status &&
    desktopPermissionReady(status.screenRecording) &&
    desktopPermissionReady(status.accessibility);
  return (
    <PermissionGuideView
      title={t("remoteDesktop.permissionsTitle")}
      intro={t(
        ready
          ? "remoteDesktop.permissionsReady"
          : "remoteDesktop.permissionsIntro",
      )}
      rows={
        status
          ? (["screenRecording", "accessibility"] as const).map(
              (permission) => ({
                label: t(`remoteDesktop.${permission}`),
                value: t(
                  desktopPermissionReady(status[permission])
                    ? "remoteDesktop.permissionGranted"
                    : status[permission] === "unknown"
                      ? "remoteDesktop.permissionUnknown"
                      : "remoteDesktop.permissionMissing",
                ),
              }),
            )
          : []
      }
      guideLabel={
        status && !ready
          ? t(
              pending
                ? "remoteDesktop.permissionChecking"
                : "remoteDesktop.openGuideOnComputer",
            )
          : undefined
      }
      pending={pending}
      onGuide={() => {
        void guide();
      }}
      reconnectLabel={t("remoteDesktop.reconnectAfterPermissions")}
      onReconnect={reconnect}
      notice={notice ? t(`remoteDesktop.${notice}`) : undefined}
    />
  );
}
