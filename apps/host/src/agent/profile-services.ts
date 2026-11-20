import { createHostToolService } from './host-tools.js';
import { createHostProjectInfoUpdate } from '../project-info.js';
import { createHostRuntimePluginSettings } from './task-runtime-plugins.js';
import type { ProfileHold } from './profile-hold.js';

/** The write services and the memory manager/MCP pair use the live queue draining this profile. */
export function bindHostProfileServices(queue: {
  profileHoldReason(): ProfileHold | null;
  profileHoldGeneration(): number;
}) {
  return {
    tools(options: Omit<Parameters<typeof createHostToolService>[0], 'profileHold'>) {
      return createHostToolService({ ...options, profileHold: () => queue.profileHoldReason() });
    },
    memoryHold: () => queue.profileHoldReason(),
    project(options: Omit<Parameters<typeof createHostProjectInfoUpdate>[0], 'profileHold'>) {
      return createHostProjectInfoUpdate({ ...options, profileHold: () => queue.profileHoldReason() });
    },
    plugins(options: Omit<Parameters<typeof createHostRuntimePluginSettings>[0], 'profileHold' | 'holdGeneration'>) {
      return createHostRuntimePluginSettings({ ...options, profileHold: () => queue.profileHoldReason(),
        holdGeneration: () => queue.profileHoldGeneration() });
    },
  };
}
