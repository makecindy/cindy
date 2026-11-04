import type { PluginTaskPermissionMode, PluginTaskRoute } from './pluginTasks.js';
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
  | { kind: 'capabilities' }
  | { kind: 'list'; targetKind: PluginTargetKind }
  | { kind: 'resolve'; target: PluginTargetRef }
  | {
      kind: 'send';
      requestKey: string;
      target: PluginTargetRef;
      /** Bot only: an opaque business topic, scoped by the Host to this plugin installation. */
      topicKey?: string;
      text: string;
      context?: string;
      attachments?: PluginMessageAttachment[];
      title?: string;
      /** Only project creation may opt into Host automatic naming. */
      autoTitle?: boolean;
      route?: PluginTaskRoute;
      /** Only project creation may select a permission within the user's plugin policy. */
      permissionMode?: PluginTaskPermissionMode;
      delivery?: PluginTargetDelivery;
      /** Opt-in scoped Auto work; requires independent agent.delegation approval. Bot + queue only. */
      delegation?: { task: string };
      /** Reference an already confirmed Host tool invocation; never grants execution authority. */
      invocationId?: string;
    }
  | { kind: 'get'; requestKey: string }
  | { kind: 'cancel'; requestKey: string };
