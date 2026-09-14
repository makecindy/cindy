import { Platform } from "react-native";

export function supportsAutoUnlock(hostPlatform: string | undefined) {
  return Platform.OS === "ios" && hostPlatform === "darwin";
}
