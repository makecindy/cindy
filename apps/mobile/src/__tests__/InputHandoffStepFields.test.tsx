// @vitest-environment jsdom
import { act, createElement, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { InputHandoffSnapshot } from "@cindy/device-link";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    View: box,
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress(): void }) =>
      createElement("button", { onClick: onPress }, children),
    Platform: { OS: "ios" },
  };
});
vi.mock("@/components/AppText", async () => {
  const { createElement } = await import("react");
  type Props = {
    accessibilityLabel: string;
    value: string;
    returnKeyType?: string;
    onChangeText(v: string): void;
    onSubmitEditing?(): void;
  };
  return {
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    // Enter stands in for the keyboard's Return key.
    TextInput: forwardRef<HTMLInputElement, Props>((props, ref) =>
      createElement("input", {
        ref,
        "aria-label": props.accessibilityLabel,
        "data-return": props.returnKeyType,
        value: props.value,
        onChange: (e: { target: { value: string } }) => props.onChangeText(e.target.value),
        onKeyDown: (e: { key: string }) => e.key === "Enter" && props.onSubmitEditing?.(),
      }),
    ),
  };
});
vi.mock("@/components/MobilePrimitives", async () => {
  const { createElement } = await import("react");
  type Action = { label: string; onPress(): void };
  const button = (action: Action) => createElement("button", { key: action.label, onClick: action.onPress }, action.label);
  return {
    MainWindowActionButton: ({ action }: { action: Action }) => button(action),
    MainWindowActionGroup: ({ cancelAction, primaryActions = [] }: { cancelAction?: Action; primaryActions?: Action[] }) =>
      createElement("div", null, ...[cancelAction, ...primaryActions].filter(Boolean).map((a) => button(a!))),
  };
});
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock("@/inputHandoff/inputHandoffStyles", () => ({ makeInputHandoffStyles: () => ({}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { InputHandoffStepFields } = await import("@/inputHandoff/InputHandoffStepFields");

let roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
});

const step: InputHandoffSnapshot = {
  kind: "input_handoff",
  requestId: "req1",
  revision: 2,
  phase: "ready",
  purpose: "Sign in",
  source: { app: "Google Chrome", origin: "https://auth.example.com" },
  stepNumber: 1,
  remoteInput: true,
  controls: [
    { id: "n0", kind: "note", tone: "error", text: "Wrong password" },
    { id: "c0", kind: "text", label: "Email", contentType: "email" },
    { id: "c1", kind: "text", label: "Password", contentType: "password" },
  ],
};

function mount(snapshot: InputHandoffSnapshot) {
  const onSubmit = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(InputHandoffStepFields, { snapshot, draft: {}, disabled: false, onChange: () => {}, onSubmit }),
    ),
  );
  return { host, onSubmit };
}

const press = (el: Element) => act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

it("shows only the fields and the page's error, with Next then Go on the keyboard", () => {
  const { host, onSubmit } = mount(step);
  expect(host.textContent).toContain("Wrong password");
  const [email, password] = Array.from(host.querySelectorAll("input"));
  expect([email.dataset.return, password.dataset.return]).toEqual(["next", "go"]);
  // No page buttons: the sheet around the fields carries Continue and Cancel.
  expect(host.querySelectorAll("button")).toHaveLength(0);

  press(email);
  expect(document.activeElement).toBe(password);
  expect(onSubmit).not.toHaveBeenCalled();
  press(password);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});
