// @vitest-environment jsdom
import { act, createElement, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { InputHandoffSnapshot } from "@cindy/device-link";

const push = vi.fn();
const openURL = vi.fn(async () => true);
const setStringAsync = vi.fn(async () => true);
const submit = vi.fn(async () => undefined);
const shareAsync = vi.fn(async () => undefined);
const writeAsStringAsync = vi.fn(async () => undefined);
const answers: unknown[] = [];
const openPicture = vi.fn(async (_snapshot: unknown, answer: (picture: unknown) => Promise<unknown>) => {
  answers.push(await answer(qrPicture));
});
vi.mock("expo-clipboard", () => ({ setStringAsync }));
vi.mock("expo-sharing", () => ({ shareAsync }));
vi.mock("expo-file-system", () => {
  class Directory {
    uri = "file:///cache/input-handoff-qr";
    exists = true;
    create() {}
    list() {
      return [];
    }
  }
  class File {
    uri: string;
    constructor(_dir: unknown, name: string) {
      this.uri = `file:///cache/input-handoff-qr/${name}`;
    }
  }
  return { Directory, File, Paths: { cache: "file:///cache" } };
});
vi.mock("expo-file-system/legacy", () => ({
  writeAsStringAsync,
  deleteAsync: vi.fn(async () => undefined),
  EncodingType: { Base64: "base64" },
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const box = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View: box,
    Text: box,
    Image: () => null,
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    ScrollView: box,
    KeyboardAvoidingView: box,
    // The sheet exists in the tree only while presented.
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? box({ children }) : null),
    Pressable: ({ children, onPress, onLayout, testID, accessibilityLabel }: { children?: ReactNode; onPress(e: unknown): void; onLayout?(e: unknown): void; testID?: string; accessibilityLabel?: string }) => {
      onLayout?.({ nativeEvent: { layout: { width: 200, height: 200 } } });
      return createElement("button", { onClick: () => onPress({ nativeEvent: { locationX: 100, locationY: 50 } }), "data-testid": testID, "aria-label": accessibilityLabel }, children);
    },
    ActivityIndicator: () => null,
    Linking: { openURL },
    Platform: { OS: "android" },
    StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("lucide-react-native", () => ({ AppWindow: () => null, Globe: () => null, Lock: () => null, QrCode: () => null, SquareTerminal: () => null }));
vi.mock("@/components/AppText", async () => {
  const { createElement } = await import("react");
  type Props = { accessibilityLabel: string; value: string; onChangeText(v: string): void; onSubmitEditing?(): void };
  return {
    Text: (await import("react-native")).Text,
    TextInput: forwardRef<HTMLInputElement, Props>((props, ref) =>
      createElement("input", {
        ref,
        "aria-label": props.accessibilityLabel,
        value: props.value,
        onChange: (e: { target: { value: string } }) => props.onChangeText(e.target.value),
        onKeyDown: (e: { key: string }) => e.key === "Enter" && props.onSubmitEditing?.(),
      }),
    ),
  };
});
vi.mock("@/components/MobilePrimitives", async () => {
  const { createElement } = await import("react");
  type Action = { label: string; disabled?: boolean; onPress(): void };
  const button = (action: Action) =>
    createElement("button", { key: action.label, disabled: action.disabled, onClick: action.onPress }, action.label);
  return {
    MainWindowActionButton: ({ action }: { action: Action }) => button(action),
    MainWindowActionGroup: ({ primaryActions = [] }: { primaryActions?: Action[] }) =>
      createElement("div", null, ...primaryActions.map(button)),
  };
});
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: {} }),
  useThemedStyles: () => ({}),
  iconSize: {},
  iconStroke: {},
  spacing: {},
}));
vi.mock("@/inputHandoff/inputHandoffStyles", () => ({ makeInputHandoffStyles: () => ({}) }));
vi.mock("@/inputHandoff/InputHandoffPictureStep", () => ({
  InputHandoffPictureStep: () => null,
  rememberInputHandoffPictureOpened: () => {},
}));
vi.mock("@/inputHandoff/useInputHandoffSubmit", () => ({
  useInputHandoffSubmit: () => ({ submit, openPicture }),
}));
vi.mock("@/auth/AuthContext", () => ({ useAuth: () => ({ deviceId: "phone" }) }));
vi.mock("@/session/remoteSessionStore", () => ({
  useRemoteDeviceIdentity: () => [{ deviceId: "mac", name: "Studio" }],
}));
vi.mock("@/utils/useGuardedPush", () => ({ useGuardedPush: () => push }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { InputHandoffCard } = await import("@/inputHandoff/InputHandoffCard");

let roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  for (const fn of [push, openURL, setStringAsync, submit, shareAsync, writeAsStringAsync, openPicture]) fn.mockClear();
  answers.length = 0;
});

const qrLink = "https://login.example.com/qr?token=abc";
const qrPicture = {
  mime: "image/jpeg",
  width: 360,
  height: 360,
  data: "Y29kZQ==",
  qr: { text: qrLink, url: qrLink },
};

const step = (overrides: Partial<InputHandoffSnapshot> = {}): InputHandoffSnapshot => ({
  kind: "input_handoff",
  requestId: "req1",
  revision: 2,
  phase: "ready",
  purpose: "Sign in",
  source: { app: "Google Chrome", origin: "https://auth.example.com" },
  stepNumber: 1,
  remoteInput: true,
  controls: [
    { id: "c0", kind: "text", label: "Email", contentType: "email" },
    { id: "c1", kind: "text", label: "Password", contentType: "password" },
  ],
  ...overrides,
});

function mount(snapshot: InputHandoffSnapshot) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onDecision = vi.fn();
  const onQuietDecision = vi.fn();
  const render = (next: InputHandoffSnapshot) =>
    act(() => {
      root.render(
        createElement(InputHandoffCard, { deviceId: "mac", snapshot: next, decisionBusy: false, onDecision, onQuietDecision }),
      );
    });
  render(snapshot);
  return { container, onDecision, onQuietDecision, render };
}
const buttons = (container: Element) => [...container.querySelectorAll("button")].map((b) => b.textContent);
const press = async (container: Element, label: string) => {
  const target = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!target) throw new Error(`no ${label} in ${buttons(container).join(", ")}`);
  await act(async () => target.click());
};
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const sheet = (container: Element) => container.querySelector('[data-testid="interaction.inputHandoff.sheet"]');

it("shows a strip with where to fill and opens the form only when asked", async () => {
  const { container, onDecision } = mount(step());
  expect(container.textContent).toContain("Sign in");
  expect(container.textContent).toContain("auth.example.com");
  expect(container.querySelector("input")).toBeNull();
  expect(buttons(container)).toEqual(["interaction.inputHandoff.action.skip", "interaction.inputHandoff.action.fill"]);

  await press(container, "interaction.inputHandoff.action.fill");
  expect(sheet(container)).not.toBeNull();
  const [email, password] = [...container.querySelectorAll("input")];
  type(email, "owner@example.test");
  type(password, "synthetic-secret");
  await press(container, "interaction.inputHandoff.action.continue");
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req1" }), {
    expectedRevision: 2,
    values: { c0: "owner@example.test", c1: "synthetic-secret" },
    action: { kind: "submit" },
  });

  // Skip on the strip cancels the handoff.
  await press(container, "interaction.inputHandoff.action.skip");
  expect(onDecision).toHaveBeenCalledWith({ kind: "input_handoff", action: "cancel", expectedRevision: 2 });
});

it("closes the sheet without cancelling, and comes back by itself for the next screen", async () => {
  const { container, onDecision, render } = mount(step());
  await press(container, "interaction.inputHandoff.action.fill");
  await press(container, "interaction.inputHandoff.action.close");
  expect(sheet(container)).toBeNull();
  expect(onDecision).not.toHaveBeenCalled();

  await press(container, "interaction.inputHandoff.action.fill");
  render(step({ revision: 3, phase: "working", controls: [] }));
  expect(sheet(container)).toBeNull();
  expect(container.textContent).toContain("interaction.inputHandoff.phase.working");
  render(step({ revision: 4, stepNumber: 2, controls: [{ id: "c2", kind: "text", label: "Code", contentType: "one-time-code" }] }));
  expect(sheet(container)).not.toBeNull();
  expect((container.querySelector("input") as HTMLInputElement).value).toBe("");
});

it("offers handing back when nothing is left to type, and a countdown when it looks done", async () => {
  const { container, onDecision, render } = mount(step({ controls: [] }));
  expect(container.textContent).toContain("interaction.inputHandoff.nothingLeft");
  await press(container, "interaction.inputHandoff.action.done");
  expect(onDecision).toHaveBeenLastCalledWith({ kind: "input_handoff", action: "done", expectedRevision: 2 });
  render(step({ phase: "finishing", controls: [] }));
  expect(buttons(container)).toEqual(["interaction.inputHandoff.action.stay", "interaction.inputHandoff.action.done"]);
});

it("opens a live view of just this window on the computer running the task", async () => {
  const { container } = mount(step({ liveView: true }));
  await press(container, "interaction.inputHandoff.action.fill");
  await press(container, "interaction.inputHandoff.action.liveView");
  expect(push).toHaveBeenCalledWith({
    pathname: "/devices/desktop/[deviceId]",
    params: { deviceId: "mac", deviceName: "Studio", handoff: "req1" },
  });
  expect(sheet(container)).toBeNull();
  const ended = mount(step({ liveView: true, phase: "cancelled", terminal: true }));
  expect(buttons(ended.container)).not.toContain("interaction.inputHandoff.action.liveView");
});

it("sends a sign-in to the live view, and keeps the form when there is none", async () => {
  const { container, onQuietDecision } = mount(step({ directSignIn: true, liveView: true }));
  expect(container.textContent).toContain("interaction.inputHandoff.directSignIn.hint");
  expect(buttons(container)).not.toContain("interaction.inputHandoff.action.fill");
  await press(container, "interaction.inputHandoff.action.openRemoteDesktop");
  expect(push).toHaveBeenCalledWith({
    pathname: "/devices/desktop/[deviceId]",
    params: { deviceId: "mac", deviceName: "Studio", handoff: "req1" },
  });
  // Working on the window takes the card, so other devices show it as being handled.
  expect(onQuietDecision).toHaveBeenCalledWith(expect.objectContaining({ action: "claim", expectedRevision: 2 }));
  await press(container, "interaction.inputHandoff.action.useForm");
  expect(buttons(container)).toContain("interaction.inputHandoff.action.fill");
  const unread = mount(step({ directSignIn: true, liveView: true, picture: true, controls: [] }));
  expect(unread.container.textContent).toContain("interaction.inputHandoff.directSignIn.hintUnread");
  expect(buttons(unread.container)).toContain("interaction.inputHandoff.action.done");
  const noLive = mount(step({ directSignIn: true }));
  expect(buttons(noLive.container)).toContain("interaction.inputHandoff.action.fill");
});

it("offers a sign-in code to copy and its link to open on this phone", async () => {
  const deviceCode = {
    code: "WDJB-MJHT",
    url: "https://github.com/login/device",
    origin: "https://github.com",
  };
  const { container, onDecision } = mount(step({ deviceCode, controls: [] }));
  await press(container, "interaction.inputHandoff.action.fill");
  expect(container.textContent).toContain("WDJB-MJHT");
  await press(container, "interaction.inputHandoff.deviceCode.copy");
  expect(setStringAsync).toHaveBeenCalledWith("WDJB-MJHT");
  expect(container.textContent).toContain("interaction.inputHandoff.deviceCode.copied");
  await press(container, "interaction.inputHandoff.deviceCode.open");
  expect(openURL).toHaveBeenCalledWith("https://github.com/login/device");
  // The sheet's main button hands back once the owner signed in there.
  await press(container, "interaction.inputHandoff.action.done");
  expect(onDecision).toHaveBeenCalledWith({ kind: "input_handoff", action: "done", expectedRevision: 2 });
  // A link whose shown origin does not match is never offered.
  const forged = mount(step({ deviceCode: { ...deviceCode, origin: "https://example.com" }, controls: [] }));
  expect(buttons(forged.container)).not.toContain("interaction.inputHandoff.action.fill");
});

it("hands a QR code from the computer to this phone: open its link here, or save or share it", async () => {
  const { container, render, onDecision } = mount(step({ controls: [], picture: true, qr: "scan" }));
  expect(buttons(container)).toEqual(["interaction.inputHandoff.action.skip", "interaction.inputHandoff.action.scan"]);
  // Nothing is fetched until the owner opens it.
  expect(openPicture).not.toHaveBeenCalled();
  await press(container, "interaction.inputHandoff.action.scan");
  expect(openPicture).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="interaction.inputHandoff.qr.code"]')).not.toBeNull();
  await press(container, "interaction.inputHandoff.qr.open");
  expect(openURL).toHaveBeenCalledWith(qrLink);
  await press(container, "interaction.inputHandoff.qr.share");
  expect(writeAsStringAsync).toHaveBeenCalledWith(expect.stringContaining("input-handoff-qr/qr-"), "Y29kZQ==", { encoding: "base64" });
  expect(shareAsync).toHaveBeenCalledWith(expect.stringContaining("input-handoff-qr/qr-"), expect.objectContaining({ mimeType: "image/jpeg" }));
  await press(container, "interaction.inputHandoff.qr.copyLink");
  expect(setStringAsync).toHaveBeenCalledWith(qrLink);
  // A tap on the code taps the same place on the code in the window.
  const code = container.querySelector('[data-testid="interaction.inputHandoff.qr.code"]') as HTMLButtonElement;
  await act(async () => code.click());
  expect(answers).toEqual([{ expectedRevision: 2, values: {}, action: { kind: "tap", x: 0.5, y: 0.25 } }]);

  // A refreshed code is a new revision and loads by itself while the sheet is open.
  render(step({ revision: 3, controls: [], picture: true, qr: "scan" }));
  expect(openPicture).toHaveBeenCalledTimes(2);

  // Scanned: the sign-in finishes on the phone that scanned it; the owner can still hand back or skip.
  render(step({ revision: 4, controls: [], qr: "scanned" }));
  expect(container.textContent).toContain("interaction.inputHandoff.qr.scanned");
  expect(sheet(container)).toBeNull();
  await press(container, "interaction.inputHandoff.action.done");
  expect(onDecision).toHaveBeenLastCalledWith({ kind: "input_handoff", action: "done", expectedRevision: 4 });
});

// ask_owner kind=scan with the agent's screenshot (2026-10-30): the host cannot see that
// screen, so the sheet says where the picture came from, has nothing to tap, and the
// owner hands back after confirming the sign-in on this phone.
it("labels a code from the agent's screenshot and lets the owner hand back after scanning", async () => {
  const { container, onDecision } = mount(step({ controls: [], picture: true, qr: "scan", agentPicture: true, agentControlled: true }));
  await press(container, "interaction.inputHandoff.action.scan");
  expect(container.textContent).toContain("interaction.inputHandoff.agentPicture");
  expect(container.textContent).not.toContain("interaction.inputHandoff.agentControlled");
  expect(container.textContent).not.toContain("interaction.inputHandoff.qr.hintLink");
  expect(buttons(container)).not.toContain("interaction.inputHandoff.action.picture");
  const code = container.querySelector('[data-testid="interaction.inputHandoff.qr.code"]') as HTMLButtonElement;
  await act(async () => code.click());
  expect(answers).toEqual([]);
  await press(container, "interaction.inputHandoff.action.done");
  expect(onDecision).toHaveBeenLastCalledWith({ kind: "input_handoff", action: "done", expectedRevision: 2 });
});

it("opens an app link here first, the way the phone camera would", async () => {
  const appLink = "weixin://dl/login?t=1";
  openPicture.mockImplementationOnce(async (_snapshot, answer) => {
    answers.push(await answer({ ...qrPicture, qr: { text: appLink, url: appLink } }));
  });
  const { container } = mount(step({ controls: [], picture: true, qr: "scan" }));
  await press(container, "interaction.inputHandoff.action.scan");
  const labels = buttons(container);
  expect(labels.indexOf("interaction.inputHandoff.qr.openApp")).toBeLessThan(labels.indexOf("interaction.inputHandoff.qr.share"));
  await press(container, "interaction.inputHandoff.qr.openApp");
  expect(openURL).toHaveBeenCalledWith(appLink);
});

it("offers content that is not a link only to save, share or copy", async () => {
  openPicture.mockImplementationOnce(async (_snapshot, answer) => {
    answers.push(await answer({ ...qrPicture, qr: { text: "WIFI:S:home;;" } }));
  });
  const { container } = mount(step({ controls: [], picture: true, qr: "scan" }));
  await press(container, "interaction.inputHandoff.action.scan");
  expect(buttons(container)).not.toContain("interaction.inputHandoff.qr.open");
  expect(buttons(container)).toContain("interaction.inputHandoff.qr.copyText");
  await press(container, "interaction.inputHandoff.qr.share");
  expect(shareAsync).toHaveBeenCalled();
  expect(openURL).not.toHaveBeenCalled();
});
