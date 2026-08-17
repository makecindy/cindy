import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('selected machine owner state', () => {
  it('reloads the module singleton when the active owner changes', async () => {
    const store = await import('@/features/device-link/selectedMachineStore');

    store.setSelectedMachineOwner('owner-a');
    store.setSelectedMachineId(['device-a']);
    expect(store.getSelectedMachineId()).toEqual(['device-a']);

    store.setSelectedMachineOwner('owner-b');
    expect(store.getSelectedMachineId()).toBe(store.MACHINE_ALL);
    store.setSelectedMachineId(['device-b']);

    store.setSelectedMachineOwner('owner-a');
    expect(store.getSelectedMachineId()).toEqual(['device-a']);
    store.setSelectedMachineOwner('owner-b');
    expect(store.getSelectedMachineId()).toEqual(['device-b']);
  });

  it('lets only the first owner claim the legacy machine selection', async () => {
    localStorage.setItem('cc-agent.sidebar.selectedMachines', '["legacy-device"]');
    const store = await import('@/features/device-link/selectedMachineStore');

    store.setSelectedMachineOwner('owner-a');
    expect(store.getSelectedMachineId()).toEqual(['legacy-device']);

    store.setSelectedMachineOwner('owner-b');
    expect(store.getSelectedMachineId()).toBe(store.MACHINE_ALL);
  });

  it('ignores persistent selection changes while no owner is bound', async () => {
    const store = await import('@/features/device-link/selectedMachineStore');

    store.setSelectedMachineOwner('owner-a');
    store.setSelectedMachineId(['device-a']);
    store.setSelectedMachineOwner(null);
    const storedKeysBefore = localStorage.length;

    store.setSelectedMachineId(['orphan-device']);

    expect(store.getSelectedMachineId()).toBe(store.MACHINE_ALL);
    expect(localStorage.length).toBe(storedKeysBefore);
    store.setSelectedMachineOwner('owner-a');
    expect(store.getSelectedMachineId()).toEqual(['device-a']);
  });
});
