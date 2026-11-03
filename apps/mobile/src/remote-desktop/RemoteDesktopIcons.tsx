import { memo } from "react";
import { createLucideIcon, type LucideProps } from "lucide-react-native";

export const WorkspaceLeftIcon = createLucideIcon(
  "RemoteDesktopWorkspaceLeft",
  [
    [
      "rect",
      { x: "3", y: "3", width: "18", height: "14", rx: "2", key: "screen" },
    ],
    ["path", { d: "M12 17v4M8 21h8M15 10H9m3-3-3 3 3 3", key: "direction" }],
  ],
);

export const WorkspaceRightIcon = createLucideIcon(
  "RemoteDesktopWorkspaceRight",
  [
    [
      "rect",
      { x: "3", y: "3", width: "18", height: "14", rx: "2", key: "screen" },
    ],
    ["path", { d: "M12 17v4M8 21h8M9 10h6m-3-3 3 3-3 3", key: "direction" }],
  ],
);

// Official Omarchy mark: https://omarchy.org/brand/omarchy-logo.svg
// Preserve its path and proportions; inherit the toolbar's Light/Dark foreground.
const OmarchyMark = createLucideIcon("RemoteDesktopOmarchyMenu", [
  [
    "path",
    {
      d: "m1200 1200h-480v-80h400v-1040h-479.996v160h-400v720h720v-720h-80v-80h159.996v880h-400v160h-640v-1200h1200zm-1120-80h480v-80h-400l.004-400h-80.004zm0-560h80.004v-400h400v-80h-480.004z",
      transform: "scale(0.02)",
      fillRule: "evenodd",
      clipRule: "evenodd",
      stroke: "none",
      key: "official-mark",
    },
  ],
]);

export const OmarchyMenuIcon = memo(
  ({ color = "currentColor", ...props }: LucideProps) => (
    <OmarchyMark {...props} color={color} fill={color} />
  ),
);

// Same 24-point grid and round line endings as the adjacent Lucide controls.
// The rear window stops at the foreground outline instead of showing through it.
export const AllWindowsIcon = createLucideIcon("RemoteDesktopAllWindows", [
  [
    "path",
    {
      d: "M4 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1",
      key: "rear",
    },
  ],
  [
    "rect",
    { x: "7", y: "8", width: "15", height: "13", rx: "2", key: "front" },
  ],
  ["path", { d: "M7 12h15", key: "titlebar" }],
]);

export const ShowDesktopIcon = createLucideIcon("RemoteDesktopShowDesktop", [
  [
    "rect",
    { x: "2", y: "3", width: "20", height: "14", rx: "2", key: "screen" },
  ],
  ["path", { d: "M8 13h8", key: "dock" }],
  ["path", { d: "M12 17v4M8 21h8", key: "stand" }],
]);
