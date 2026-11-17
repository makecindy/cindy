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

// A foldable's postures, drawn as the desktop viewer draws them (cindy-simulator
// control.html): closed, half open and flat. The camera dot is a stroked point,
// since a child's own currentColor fill does not resolve here.
export const PostureClosedIcon = createLucideIcon("LiveScreenPostureClosed", [
  [
    "path",
    {
      d: "M6.3 3.25h9.1a3 3 0 0 1 3 3v11.5a3 3 0 0 1-3 3H6.3a.7.7 0 0 1-.7-.7V3.95a.7.7 0 0 1 .7-.7z",
      key: "body",
    },
  ],
  [
    "circle",
    { cx: "15.4", cy: "6.3", r: ".45", strokeWidth: "0.9", key: "camera" },
  ],
  ["path", { d: "M9.9 18.55h4.2", strokeWidth: "1.1", key: "bar" }],
]);

export const PostureOpenIcon = createLucideIcon("LiveScreenPostureOpen", [
  [
    "path",
    {
      d: "M2.7 6.8Q2.7 3.91 5.5 4.3L12 5.2l6.5-.9q2.8-.39 2.8 2.5v10.4q0 2.89-2.8 2.5L12 18.8l-6.5.9q-2.8.39-2.8-2.5z",
      key: "book",
    },
  ],
]);

export const PostureFlatIcon = createLucideIcon("LiveScreenPostureFlat", [
  [
    "rect",
    {
      x: "2.5",
      y: "4.47",
      width: "19",
      height: "15.06",
      rx: "2.7",
      key: "screen",
    },
  ],
  ["path", { d: "M9.45 17.65h5.1", strokeWidth: "1.1", key: "bar" }],
]);
