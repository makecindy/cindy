import { createLucideIcon } from "lucide-react-native";

// Same 24-point grid and round line endings as the adjacent Lucide controls.
// The rear window stops at the foreground outline instead of showing through it.
export const AllWindowsIcon = createLucideIcon("RemoteDesktopAllWindows", [
  ["path", { d: "M4 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1", key: "rear" }],
  ["rect", { x: "7", y: "8", width: "15", height: "13", rx: "2", key: "front" }],
  ["path", { d: "M7 12h15", key: "titlebar" }],
]);

export const ShowDesktopIcon = createLucideIcon("RemoteDesktopShowDesktop", [
  ["rect", { x: "2", y: "3", width: "20", height: "14", rx: "2", key: "screen" }],
  ["path", { d: "M8 13h8", key: "dock" }],
  ["path", { d: "M12 17v4M8 21h8", key: "stand" }],
]);
