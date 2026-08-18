/** Device-neutral input actions and capability cards for hardware adapters. */

export const INPUT_DEVICE_COMMAND_IDS = [
  'composer.toggleFastMode',
  'approval.approve',
  'approval.decline',
  'forkTask',
  'composer.submit',
  'feedback',
  'toggleTerminal',
  'copyConversationMarkdown',
  'archiveTask',
  'newTask',
  'openBrowserTab',
  'toggleTaskPin',
  'toggleReviewTab',
  'composer.addPhotos',
  'settings',
  'manageTasks',
  'composer.increaseReasoningEffort',
  'composer.decreaseReasoningEffort',
  'openFolder',
  'composer.addFiles',
  'openSkills',
  'composer.togglePlanMode',
  'navigateForward',
  'toggleSidebar',
  'toggleRightSidebar',
  'navigateBack',
  'composer.focus',
  'conversation.scrollUp',
  'conversation.scrollDown',
  'conversation.scrollBottom',
  'session.selectPrevious',
  'session.selectNext',
] as const;

export type InputDeviceCommandId = (typeof INPUT_DEVICE_COMMAND_IDS)[number];

export type InputDeviceAction =
  | { type: 'command'; commandId: InputDeviceCommandId }
  | { type: 'task'; sessionId: string }
  | { type: 'skill'; skillId: string; name: string }
  | { type: 'composer-text'; text: string }
  | { type: 'external-url'; url: string };

export type InputDeviceRendererAction =
  | Exclude<InputDeviceAction, { type: 'task' }>
  | { type: 'voice'; phase: 'press' | 'release' }
  | {
      type: 'scroll';
      direction: 'up' | 'down';
      intensity: number;
    }
  | { type: 'scroll-stop' }
  | { type: 'keyboard'; key: 'ArrowUp' | 'ArrowDown' | 'Enter' };

export type InputDeviceCapability =
  | { kind: 'task-slots'; count: number }
  | { kind: 'commands' }
  | { kind: 'voice' }
  | { kind: 'encoder' }
  | { kind: 'stick' }
  | { kind: 'lighting'; model: 'task-slots' | 'global' | 'none' };

export interface InputDeviceDescriptor {
  id: string;
  label: string;
  capabilities: readonly InputDeviceCapability[];
}

export interface InputDevicePublishedTask {
  id: string;
  title: string | null;
  pinnedAt: number | null;
  /** Last time the user sent a message, in unix ms. Null if they never have. */
  userSendAt: number | null;
  /** 0-based order among currently visible sidebar rows. Absent when hidden. */
  sidebarOrder?: number;
  /**
   * False when this row is only a visible projection (for example an archived
   * task in the current sidebar filter) and must not occupy last-sent /
   * priority / custom catalogs.
   */
  catalogEligible?: boolean;
}

export function isInputDeviceCommandId(value: unknown): value is InputDeviceCommandId {
  return typeof value === 'string' && (INPUT_DEVICE_COMMAND_IDS as readonly string[]).includes(value);
}

export function inputDeviceHasCapability(
  device: InputDeviceDescriptor,
  kind: InputDeviceCapability['kind'],
): boolean {
  return device.capabilities.some((capability) => capability.kind === kind);
}
