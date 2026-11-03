import type { HandoffDriver } from '../macDriver.js';
import type { NativeActRequest, NativeAxNode, NativeAxSnapshot, NativeWindowList, PointerRequest } from '../types.js';

const node = (ref: string, role: string, extra: Partial<NativeAxNode> = {}): NativeAxNode => ({
  ref, role, depth: 1, fp: `${role}|${extra.title ?? ''}`, enabled: true, frame: [10, 10, 100, 20], ...extra,
});

export type FakeStage = 'choose' | 'account' | 'password' | 'consent' | 'done';

/**
 * A generic sign-in: pick a method (buttons only) → account name in the app →
 * password on the browser's sign-in page → consent (buttons only) → back in the app.
 * Only the account and password steps have anything for the owner to type.
 */
export function fakeDesktop(options: {
  pictures?: boolean;
  live?: boolean;
  start?: FakeStage;
  /** The app turns the account down: pressing Next leaves the form as it was. */
  rejects?: boolean;
} = {}) {
  let stage: FakeStage = options.start ?? 'account';
  const acts: NativeActRequest[] = [];
  const pointers: PointerRequest[] = [];
  const raised: number[] = [];
  let switched = false;
  const app = { pid: 10, app: 'Example', bundleId: 'com.example.app' };
  const browser = { pid: 20, app: 'Google Chrome', bundleId: 'com.google.Chrome' };
  const inBrowser = () => stage === 'password' || stage === 'consent';
  const windows = (): NativeWindowList => ({
    frontmost: inBrowser() || switched ? 20 : 10,
    apps: [
      { ...app, windows: [{ index: 0, title: stage === 'done' ? 'Example' : 'Sign in', frame: [0, 0, 800, 600], focused: true, minimized: false }] },
      // The browser was already open; the app opening the sign-in page turns its window into that page.
      { ...browser, windows: [{ index: 0, title: stage === 'choose' || stage === 'account' ? 'New Tab' : 'Sign in - Example', frame: [0, 0, 800, 600], focused: true, minimized: false }] },
      { pid: 1, app: 'Cindy', bundleId: 'host', windows: [{ index: 0, title: 'Cindy', frame: [0, 0, 1, 1], focused: true, minimized: false }] },
    ],
  });
  const snapshot = (pid: number): NativeAxSnapshot => {
    const base = { pid, frontmost: true, window: { index: 0, title: '', frame: [0, 0, 800, 600] } };
    if (pid === 20) {
      const page = (url: string, nodes: NativeAxNode[]) => [node('0', 'AXWebArea', { url, frame: [0, 0, 800, 600] }), ...nodes];
      const nodes = stage === 'password'
        ? page('https://auth.example.com/login', [
          node('0.0', 'AXHeading', { title: 'Enter your password' }),
          node('0.1', 'AXTextField', { title: 'Password', secure: true }),
          node('0.2', 'AXButton', { title: 'Sign in' }),
          node('0.3', 'AXLink', { title: 'Forgot password?' }),
        ])
        : stage === 'consent'
          ? page('https://auth.example.com/consent', [
            node('0.0', 'AXHeading', { title: 'Allow Example to access your account?' }),
            node('0.1', 'AXButton', { title: 'Authorize' }),
            node('0.2', 'AXButton', { title: 'Cancel' }),
          ])
          : page('https://auth.example.com/ok', [node('0.0', 'AXStaticText', { value: 'You can close this tab' })]);
      return { ...base, ...browser, window: { ...base.window, title: 'Sign in - Example' }, nodes };
    }
    if (stage === 'choose') return { ...base, ...app, window: { ...base.window, title: 'Sign in' }, nodes: [
      node('0', 'AXRadioGroup', { desc: 'Sign-in method' }),
      node('0.0', 'AXRadioButton', { title: 'Personal', checked: true }),
      node('0.1', 'AXRadioButton', { title: 'Enterprise', checked: false }),
      node('1', 'AXButton', { title: 'Continue' }),
    ] };
    if (stage === 'account' || inBrowser()) return { ...base, ...app, window: { ...base.window, title: 'Sign in' }, nodes: [
      node('0', 'AXTextField', { title: 'Email' }),
      node('1', 'AXButton', { title: 'Next' }),
    ] };
    return { ...base, ...app, window: { ...base.window, title: 'Example' }, nodes: [
      node('0', 'AXButton', { title: 'New task' }),
      node('1', 'AXButton', { title: 'Settings' }),
      node('2', 'AXTextField', { title: 'Search', subrole: 'AXSearchField' }),
    ] };
  };
  const driver: HandoffDriver = {
    permission: async () => 'granted',
    requestPermission: async () => undefined,
    windows: async () => windows(),
    snapshot: async (pid) => snapshot(pid),
    commandLine: async () => '',
    act: async (request) => {
      acts.push(request);
      const press = request.kind === 'press';
      if (stage === 'choose' && press && request.ref === '1') stage = 'account';
      else if (stage === 'account' && press && request.ref === '1' && !options.rejects) stage = 'password';
      else if (stage === 'password' && press && request.ref === '0.2') stage = 'consent';
      else if (stage === 'consent' && press && request.ref === '0.1') stage = 'done';
      return { ok: true };
    },
    ...(options.pictures
      ? {
          capture: async () => {
            const frame = [0, 0, 800, 600];
            return { jpeg: Buffer.from(`picture-of-${stage}`), width: 800, height: 600, area: frame, windowFrame: frame };
          },
          focusedField: async () => ({ editable: false, secure: false }),
          // A tap on the main button (bottom right of the picture) moves on like pressing it.
          pointer: async (request: PointerRequest) => {
            pointers.push(request);
            if (request.kind === 'tap' && request.point[0] > 400) {
              if (stage === 'choose') stage = 'account';
              else if (stage === 'account') stage = 'password';
            }
            return { ok: true as const };
          },
        }
      : {}),
    ...(options.live
      ? {
          raise: async (target: { pid: number }) => {
            raised.push(target.pid);
            return { frame: [0, 0, 800, 600], windowId: 900 + target.pid };
          },
        }
      : {}),
  };
  return {
    driver,
    acts,
    pointers,
    raised,
    stage: () => stage,
    /** The owner, at the computer, switches to the browser they already had open. */
    switchToBrowser: () => {
      switched = true;
    },
    /** The owner (in the live view) or the agent moved the screen on, outside the card. */
    advanceOutside: (next: FakeStage) => {
      stage = next;
    },
  };
}
