import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';
import type { InputDeviceDescriptor } from '../../shared/inputDevices.js';

export interface InputDeviceHost {
  readonly descriptor: InputDeviceDescriptor;
  start(): void;
  updateSessionActivity(activity: readonly AgentIslandSessionActivity[]): void;
  playWindowReveal?(): void;
  resumeTaskSlots(): Promise<void>;
  suspendTaskSlots(): void;
  dispose(): Promise<void>;
}

const hosts = new Map<string, InputDeviceHost>();

export function registerInputDevice(host: InputDeviceHost): void {
  hosts.set(host.descriptor.id, host);
}

export function listInputDevices(): InputDeviceDescriptor[] {
  return [...hosts.values()].map((host) => host.descriptor);
}

export function startInputDevices(): void {
  for (const host of hosts.values()) host.start();
}

export function updateInputDeviceSessionActivity(
  activity: readonly AgentIslandSessionActivity[],
): void {
  for (const host of hosts.values()) host.updateSessionActivity(activity);
}

export function playInputDeviceWindowReveal(): void {
  for (const host of hosts.values()) host.playWindowReveal?.();
}

export async function resumeInputDeviceTaskSlots(): Promise<void> {
  await Promise.all([...hosts.values()].map((host) => host.resumeTaskSlots()));
}

export function suspendInputDeviceTaskSlots(): void {
  for (const host of hosts.values()) host.suspendTaskSlots();
}

export async function disposeInputDevices(): Promise<void> {
  const registered = [...hosts.values()];
  hosts.clear();
  await Promise.all(registered.map((host) => host.dispose()));
}
