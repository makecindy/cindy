import { PluginTargetSlot as SharedPluginTargetSlot } from '@cindy/plugin-runtime/pluginTargetSlot';
import { getActiveDataOwnerPushStamp, activeOwnerScopeKey } from '../appSessionState.js';
export * from '@cindy/plugin-runtime/pluginTargetSlot';
export class PluginTargetSlot extends SharedPluginTargetSlot {
  constructor() { super(() => [activeOwnerScopeKey(), getActiveDataOwnerPushStamp().ownerGeneration]); }
}
