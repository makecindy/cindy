import type { PluginTaskRoute } from './pluginTasks.js';
import type { PluginMessageAttachment } from './pluginAttachments.js';

/** Requires agent.tasks + agent.targets and independent Host consent; does not read history. */
export type PluginTargetKind = 'project' | 'task' | 'bot';
export type PluginTargetDelivery = 'queue' | 'steer';
export interface PluginTargetRef {
  kind: PluginTargetKind;
  /** Project directory, task ID or companion ID from targets.list/resolve. */
  id: string;
}
export interface PluginTargetView extends PluginTargetRef {
  label: string;
  detail: string;
}
/** Local target metadata; no messages or task history. */
export interface PluginTargetCandidate {
  id: string;
  label: string;
  detail: string;
}
export type PluginTargetRequest =
  | { kind: 'list'; targetKind: PluginTargetKind }
  | { kind: 'resolve'; target: PluginTargetRef }
  | {
      kind: 'send';
      requestKey: string;
      target: PluginTargetRef;
      text: string;
      attachments?: PluginMessageAttachment[];
      title?: string;
      route?: PluginTaskRoute;
      delivery?: PluginTargetDelivery;
    }
  | { kind: 'cancel'; requestKey: string };
