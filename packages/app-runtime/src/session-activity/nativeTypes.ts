import type { AgentIslandDisplayState, AgentIslandSoundChoice } from '@cindy/maker-shared/agentIsland';
import type { AgentIslandLayoutPreference } from './geometry.js';
export interface Rectangle { x: number; y: number; width: number; height: number }
export interface AgentIslandNativeFrame extends Rectangle {
  displayId: number;
  displayBounds: Rectangle;
  contentWidth?: number | null;
}

export interface AgentIslandNativeScreenMetrics {
  displayId: number;
  frame: Rectangle;
  hasNotch: boolean;
  notchWidth: number;
  topBarHeight: number;
  menuBarHeight: number;
  safeAreaTop: number;
  isMain: boolean;
  signature: string;
}

export interface MacAgentIslandNativeHostOptions {
  onPointerZones: (zones: { menuBar: boolean; panel: boolean; displayId?: number | null }) => void;
  onExpand: (displayId?: number | null) => void;
  onCollapse: (displayId?: number | null) => void;
  onFocusSession: (sessionId: string) => void;
  onCompletionAction?: (sessionId: string, action: 'mark-read' | 'archive', completionToken: string) => Promise<boolean>;
  onOpenSettings: () => void;
  onNewMessage: () => void;
  onToggleSound: () => void;
  onPermissionAction: (action: {
    requestId: string;
    action: 'allow' | 'allowForSession' | 'deny';
  }) => void;
  onOutsideClick: () => void;
  onLayoutDragActive: (active: boolean) => void;
  onLayoutPreference: (preference: AgentIslandLayoutPreference) => void;
  onContentHeight: (height: number) => void;
  onScreenMetrics: (metrics: {
    screens: AgentIslandNativeScreenMetrics[];
    preferredDisplayId: number | null;
    forceRefresh: boolean;
  }) => void;
}

