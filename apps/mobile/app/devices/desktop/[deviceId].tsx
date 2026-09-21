import { Stack } from "expo-router";
import RemoteDesktopScreen from "@/remote-desktop/RemoteDesktopScreen";
import { NativeRemoteDesktopView } from "@/remote-desktop/NativeRemoteDesktopView";

export default function RemoteDesktopRoute() {
  if (!NativeRemoteDesktopView) return <RemoteDesktopScreen />;
  return (
    <Stack.Screen
      options={{
        headerShown: false,
        gestureEnabled: false,
        statusBarHidden: true,
      }}
    />
  );
}
