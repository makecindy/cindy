import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useNavigationContainerRef, useRouter } from "expo-router";
import { useNavigationState } from "expo-router/react-navigation";
import { useAuth } from "@/auth/AuthContext";
import {
  removeDesktopHistory,
  activeDesktopRoute,
  REMOTE_DESKTOP_ROUTE,
} from "./remoteDesktopNavigation";
import { NativeRemoteDesktopView } from "./NativeRemoteDesktopView";
import { RemoteDesktopSession } from "./RemoteDesktopScreen";
import { logDesktopNavigation } from "./remoteDesktopNavigationDebug";

type Session = { account: string; deviceId: string; deviceName: string };

/** One connected viewer survives its route, but never its signed-in owner. */
export function RemoteDesktopHost({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const navigation = useNavigationContainerRef();
  const rootState = useNavigationState((state) => state);
  const route = activeDesktopRoute(rootState);
  const params = route?.params as
    { deviceId?: string; deviceName?: string } | undefined;
  const account =
    auth.isAuthenticated && auth.user?.id
      ? `${auth.user.id}:${auth.accountGeneration}`
      : undefined;
  const inDesktop = route?.name === REMOTE_DESKTOP_ROUTE;
  const routeDevice =
    inDesktop && typeof params?.deviceId === "string" ? params.deviceId : "";
  const routeName =
    typeof params?.deviceName === "string" ? params.deviceName : routeDevice;
  const [session, setSession] = useState<Session | null>(null);
  const [visible, setVisible] = useState(true);
  const restorePending = useRef<Session | null>(null);
  useEffect(() => {
    if (!NativeRemoteDesktopView || !account) {
      setSession(null);
      return;
    }
    if (routeDevice) {
      setSession((current) =>
        current?.account === account && current.deviceId === routeDevice
          ? current
          : { account, deviceId: routeDevice, deviceName: routeName },
      );
      setVisible(true);
    } else
      setSession((current) => (current?.account === account ? current : null));
  }, [account, routeDevice, routeName]);
  const current = session?.account === account ? session : null;
  const owner = useRef(current);
  owner.current = current;
  useEffect(
    () =>
      navigation.addListener("state", () => {
        logDesktopNavigation("container event", navigation.getRootState());
      }),
    [navigation],
  );
  useEffect(() => {
    logDesktopNavigation("host observed", rootState, {
      hasSession: Boolean(current),
      focused: Boolean(current && routeDevice === current.deviceId),
      visible,
    });
  }, [rootState, current, routeDevice, visible]);
  useEffect(() => {
    if (restorePending.current !== current || routeDevice === current?.deviceId)
      restorePending.current = null;
  }, [current, routeDevice]);
  useEffect(() => {
    if (!NativeRemoteDesktopView || !rootState) return;
    // Drop abandoned desktop entries even if another page was pushed before
    // a delayed PiP transition completed. Ordinary Back then stays ordinary.
    const next = removeDesktopHistory(
      rootState,
      inDesktop ? route?.key : undefined,
    );
    if (next && next !== rootState) {
      logDesktopNavigation("cleanup before", navigation.getRootState());
      logDesktopNavigation("cleanup requested", next);
      navigation.resetRoot(next);
      logDesktopNavigation("cleanup dispatched", navigation.getRootState());
    }
  }, [rootState, inDesktop, route?.key, navigation]);
  const foreground = visible && routeDevice === current?.deviceId;
  return (
    <View style={styles.root}>
      {children}
      {NativeRemoteDesktopView && current && (
        <View
          style={[StyleSheet.absoluteFill, { opacity: foreground ? 1 : 0 }]}
          pointerEvents={foreground ? "auto" : "none"}
          accessibilityElementsHidden={!foreground}
          importantForAccessibility={
            foreground ? "auto" : "no-hide-descendants"
          }
          collapsable={false}
        >
          <RemoteDesktopSession
            key={`${current.account}:${current.deviceId}`}
            deviceId={current.deviceId}
            deviceName={current.deviceName}
            focused={routeDevice === current.deviceId}
            onBack={() => {
              logDesktopNavigation("back callback", navigation.getRootState(), {
                sameOwner: owner.current === current,
                sourceFocused: routeDevice === current.deviceId,
              });
              if (owner.current !== current || routeDevice !== current.deviceId)
                return;
              restorePending.current = null;
              const state = navigation.getRootState();
              if (!state) return;
              const active = activeDesktopRoute(state);
              const keepKey =
                active?.name === REMOTE_DESKTOP_ROUTE &&
                active.key !== route?.key
                  ? active.key
                  : undefined;
              const next = removeDesktopHistory(state, keepKey);
              logDesktopNavigation("back decision", next ?? undefined, {
                sameSourceRoute: active?.key === route?.key,
                preserveNewDesktop: Boolean(keepKey),
                action: !next
                  ? "replace-home"
                  : next !== state
                    ? "reset"
                    : "none",
              });
              if (!next) router.replace("/");
              else if (next !== state) navigation.resetRoot(next);
              logDesktopNavigation(
                "back dispatched",
                navigation.getRootState(),
              );
            }}
            onRestore={() => {
              logDesktopNavigation(
                "restore callback",
                navigation.getRootState(),
                {
                  sameOwner: owner.current === current,
                  pending: restorePending.current === current,
                },
              );
              if (
                owner.current !== current ||
                restorePending.current === current
              )
                return;
              const state = navigation.getRootState();
              const active = activeDesktopRoute(state);
              if (
                active?.name === REMOTE_DESKTOP_ROUTE &&
                (active.params as { deviceId?: string } | undefined)
                  ?.deviceId === current.deviceId
              )
                return;
              restorePending.current = current;
              logDesktopNavigation("restore push", state);
              router.push({
                pathname: "/devices/desktop/[deviceId]",
                params: {
                  deviceId: current.deviceId,
                  deviceName: current.deviceName,
                },
              });
            }}
            onVisibility={(next) => {
              logDesktopNavigation("visibility", navigation.getRootState(), {
                visible: next,
                sameOwner: owner.current === current,
              });
              if (owner.current === current) setVisible(next);
            }}
            onEnded={() => {
              logDesktopNavigation("ended", navigation.getRootState(), {
                sameOwner: owner.current === current,
              });
              setSession((owner) => (owner === current ? null : owner));
            }}
          />
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 } });
