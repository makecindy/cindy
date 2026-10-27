// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { OrcaWorkerFormView } from '@/session/ContextSheetCollabView';
import type { OrcaWorkerFormValue } from '@/session/orcaTeam';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, View: 'div' }));
vi.mock('lucide-react-native', () => ({ CircleStop: () => null, UserPlus: () => null }));
vi.mock('@/theme', () => ({
  iconSize: {}, iconStroke: {}, lineHeight: {}, radius: {}, typeScale: {},
  useTheme: () => ({ colors: {} }),
}));
vi.mock('@/session/ContextSheet', () => {
  const SelectRow = (props: {
    testID?: string; value: string; disabled?: boolean;
    options: Array<{ id: string; label: string; disabled?: boolean }>;
    onChange(value: string): void;
  }) => <select data-testid={props.testID} value={props.value} disabled={props.disabled}
    onChange={event => props.onChange(event.target.value)}>
    {props.options.map(option => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
  </select>;
  return {
    ContextSheetGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ContextSheetChoiceRow: SelectRow, ContextSheetSelectRow: SelectRow,
    ContextSheetRow: ({ testID, onPress }: { testID?: string; onPress?(): void }) =>
      <button data-testid={testID} onClick={onPress} />,
    ContextSheetTextField: () => null, ContextSheetError: () => null, ContextSheetNote: () => null,
  };
});

// PR #6787, unit: render the production form through its controls. The existing
// hook tests mock this component, so they cannot detect its mutual-exclusion gate.
// This DOM fixture needs a separate file from the hook's module/native mocks.
it.each([false, true])('keeps the work computer editable after choosing a model computer (work chosen first=%s)', async workFirst => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const changed = vi.fn();
  function Form() {
    const [form, setForm] = useState<OrcaWorkerFormValue>({
      role: 'developer', agent: 'codex', permissionMode: 'auto', model: null, initialTask: '',
      ...(workFirst ? { executionDeviceId: 'work-b' } : {}),
    });
    return <OrcaWorkerFormView form={form} customRoleMode={false} onCustomRoleModeChange={() => {}}
      onChange={patch => { changed(patch); setForm(current => ({ ...current, ...patch })); }}
      onAgentChange={() => {}} onPermissionChange={() => {}} agents={['codex']} busy={false}
      onPickDirectory={() => {}} onPickModel={() => setForm(current => ({ ...current, agentDeviceId: 'model-c' }))}
      executionDevices={[
        { deviceId: 'work-b', name: 'B', platform: 'win32', supported: true },
        { deviceId: 'work-d', name: 'D', platform: 'darwin', supported: true },
      ]} />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Form />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="collab.modelRow"]')!.click());
    const selector = container.querySelector<HTMLSelectElement>('[data-testid="collab.executionDevice"]');
    expect(selector).not.toBeNull();
    expect(selector!.disabled).toBe(false);
    await act(async () => { selector!.value = 'work-d'; selector!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(changed).toHaveBeenLastCalledWith({ executionDeviceId: 'work-d' });
    await act(async () => { selector!.value = '__lead__'; selector!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(changed).toHaveBeenLastCalledWith({ executionDeviceId: undefined });
    expect(container.querySelector<HTMLSelectElement>('[data-testid="collab.executionDevice"]')?.value).toBe('__lead__');
  } finally { await act(async () => root.unmount()); }
});
