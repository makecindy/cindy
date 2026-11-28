import { snapshotForSeed } from './providerModelMemory';

/** Remembered reasoning effort by memory slot and model, as the model settings show it. */
export function modelEffortSnapshot(): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(snapshotForSeed()).map(([slot, memory]) => [slot, { ...memory.effortByModel }]));
}
