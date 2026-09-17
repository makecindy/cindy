// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextSheetGoalCreateForm, ContextSheetGoalView } from '@/session/ContextSheetGoalView.ios';

const bridge = vi.hoisted(() => ({ props: new Map<string, any>() }));
vi.mock('@expo/ui/swift-ui', async () => {
  const React = await import('react');
  const control = (p: any) => {
    if (p.testID) bridge.props.set(p.testID, p);
    return React.createElement('div', null, p.children);
  };
  return { Button: control, DisclosureGroup: control, Picker: control, ProgressView: control, Text: control, TextField: control,
    useNativeState: (initial: string) => {
      const state = React.useRef({ value: initial, get() { return this.value; }, set(value: string) { this.value = value; } });
      return state.current;
    },
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => Object.fromEntries(
  ['accessibilityHint', 'accessibilityLabel', 'buttonStyle', 'contentShape', 'disabled', 'font', 'foregroundStyle', 'frame', 'lineLimit', 'pickerStyle', 'tag'].map(key => [key, (value: any) => ({ [key]: value })]).concat([['shapes', { rectangle: () => ({}) }] as any]),
));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/session/ComposerNativeSection', () => ({ ComposerNativeSection: (p: any) => createElement('section', null, p.children) }));
vi.mock('@/session/goalStatusLabel', () => ({ goalReasonText: () => '', goalStatusLabel: (status: string) => status, GOAL_STATUS_LABEL: {} }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); bridge.props.clear(); });
function mount(props: any = {}, component: any = ContextSheetGoalCreateForm) {
  const root = createRoot(document.createElement('div'));
  const onSetGoal = vi.fn();
  act(() => root.render(createElement(component, { busy: false, error: null, onSetGoal, ...props })));
  cleanup.push(() => act(() => root.unmount()));
  return onSetGoal;
}
const control = (id: string) => bridge.props.get(`contextSheet.${id}`);

it('submits trimmed native text without overriding remote defaults', () => {
  const submit = mount();
  act(() => { control('goalObjectiveInput').text.set('  完成目标  '); control('goalObjectiveInput').onTextChange('  完成目标  '); });
  act(() => control('goalStartButton').onPress());
  expect(submit).toHaveBeenCalledWith({ objective: '完成目标' });
});

it('preserves restored custom limits and changes only the selected field', () => {
  const limits = { maxTurns: 17, budgetTokens: 123456, noProgressLimit: 4 };
  const submit = mount({ initial: { objective: '恢复目标', limits } });
  expect(control('goalMaxTurnsOptions').selection).toBe(17);
  expect(control('goalBudgetOptions').selection).toBe(123456);
  act(() => control('goalNoProgressOptions').onSelectionChange('unlimited'));
  act(() => control('goalStartButton').onPress());
  expect(submit).toHaveBeenCalledWith({ objective: '恢复目标', limits: { ...limits, noProgressLimit: null } });
});

it.each([{ busy: true }, { disabled: true }, { initial: { objective: '   ' } }])('guards unavailable submission: %j', props => {
  const submit = mount({ initial: { objective: '目标' }, ...props });
  act(() => control('goalStartButton').onPress());
  expect(submit).not.toHaveBeenCalled();
});

it.each(['active', 'paused', 'blocked', 'usageLimited', 'completed'])('keeps status actions for %s', status => {
  mount({ goal: { status, objective: '目标', turnsUsed: 1, tokensUsed: 5, maxTurns: null, budgetTokens: null }, onPauseGoal: vi.fn(), onResumeGoal: vi.fn(), onClearGoal: vi.fn() }, ContextSheetGoalView);
  expect(!!control('goalPauseButton')).toBe(status === 'active');
  expect(!!control('goalResumeButton')).toBe(['paused', 'blocked', 'usageLimited'].includes(status));
  expect(control('goalClearButton')).toBeDefined();
});
