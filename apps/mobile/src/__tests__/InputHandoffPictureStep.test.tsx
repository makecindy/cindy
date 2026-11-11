// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type {
  InputHandoffPicture,
  InputHandoffSnapshot,
  InputHandoffSubmission,
} from "@cindy/device-link";

vi.mock("react-native", async () => {
  const { createElement, useEffect } = await import("react");
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    View: box,
    Text: box,
    ActivityIndicator: () => null,
    Image: ({ source }: { source: { uri: string } }) => createElement("img", { src: source.uri }),
    // The picture is laid out at 400×300; a press lands at (100, 225) inside it.
    Pressable: ({
      children,
      onPress,
      onLayout,
      accessibilityLabel,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: (event: unknown) => void;
      onLayout?: (event: unknown) => void;
      accessibilityLabel?: string;
      disabled?: boolean;
    }) => {
      useEffect(() => onLayout?.({ nativeEvent: { layout: { width: 400, height: 300 } } }), []);
      return createElement(
        "button",
        {
          "aria-label": accessibilityLabel,
          disabled,
          onClick: () => onPress?.({ nativeEvent: { locationX: 100, locationY: 225 } }),
        },
        children,
      );
    },
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      secureTextEntry,
    }: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (value: string) => void;
      secureTextEntry?: boolean;
    }) =>
      createElement("input", {
        "aria-label": accessibilityLabel,
        type: secureTextEntry ? "password" : "text",
        value,
        onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
      }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  };
});
vi.mock("@/components/AppText", async () => {
  const rn = await import("react-native");
  return { Text: rn.Text, TextInput: rn.TextInput };
});
vi.mock("@/components/MobilePrimitives", async () => {
  const { createElement } = await import("react");
  type Action = { label: string; disabled?: boolean; onPress(): void };
  const button = (action: Action) =>
    createElement("button", { key: action.label, disabled: action.disabled, onClick: action.onPress }, action.label);
  return {
    MainWindowActionGroup: ({
      cancelAction,
      secondaryActions = [],
      primaryActions = [],
    }: {
      cancelAction?: Action;
      secondaryActions?: Action[];
      primaryActions?: Action[];
    }) =>
      createElement(
        "div",
        null,
        ...[cancelAction, ...secondaryActions, ...primaryActions].filter(Boolean).map((a) => button(a!)),
      ),
  };
});
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: {} }),
  useThemedStyles: () => ({}),
}));
vi.mock("@/inputHandoff/inputHandoffStyles", () => ({ makeInputHandoffStyles: () => ({}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { InputHandoffPictureStep } = await import("@/inputHandoff/InputHandoffPictureStep");

const picture: InputHandoffPicture = { mime: "image/jpeg", width: 800, height: 600, data: "AAAA" };
let roots: Root[] = [];
let nextRequest = 0;
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  document.body.innerHTML = "";
});

const shot = (overrides: Partial<InputHandoffSnapshot> = {}): InputHandoffSnapshot => ({
  kind: "input_handoff",
  requestId: `phone${++nextRequest}`,
  revision: 3,
  phase: "ready",
  purpose: "Sign in",
  source: { app: "Game" },
  stepNumber: 1,
  remoteInput: true,
  controls: [],
  picture: true,
  ...overrides,
});

/** A Host exchange that shows the picture, then waits for the owner's answer. */
function exchange() {
  const answers: InputHandoffSubmission[] = [];
  const errors: unknown[] = [];
  const openPicture = vi.fn(
    (_snapshot: InputHandoffSnapshot, answer: (p: InputHandoffPicture) => Promise<InputHandoffSubmission>) =>
      answer(picture).then(
        (submission) => {
          answers.push(submission);
        },
        (error) => {
          errors.push(error);
          throw error;
        },
      ),
  );
  return { openPicture, answers, errors };
}

function mount(snapshot: InputHandoffSnapshot, openPicture: ReturnType<typeof exchange>["openPicture"]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const onDecide = vi.fn();
  act(() => {
    root.render(
      createElement(InputHandoffPictureStep, { snapshot, busy: false, openPicture, onDecide, onError: () => {} }),
    );
  });
  return { container, root, onDecide };
}

const click = async (element: Element | null | undefined) => {
  await act(async () => {
    (element as HTMLElement).click();
  });
};
const byText = (container: Element, text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text);

it("fetches the sealed picture only when the owner asks, then sends the tap as a fraction", async () => {
  const host = exchange();
  const { container } = mount(shot(), host.openPicture);
  expect(host.openPicture).not.toHaveBeenCalled();
  await click(byText(container, "interaction.inputHandoff.picture.open"));
  const image = container.querySelector('button[aria-label="interaction.inputHandoff.picture.alt"]');
  expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  await click(image);
  expect(host.answers).toEqual([{ expectedRevision: 3, values: {}, action: { kind: "tap", x: 0.25, y: 0.75 } }]);
});

it("types into the focused field with the system secure field", async () => {
  const host = exchange();
  const snapshot = shot({ controls: [{ id: "typed", kind: "text", label: "", contentType: "password" }] });
  const { container } = mount(snapshot, host.openPicture);
  await click(byText(container, "interaction.inputHandoff.picture.open"));
  const field = container.querySelector("input")!;
  expect(field.type).toBe("password");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, "synthetic-pass");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(byText(container, "interaction.inputHandoff.picture.typeEnter"));
  expect(host.answers).toEqual([{ expectedRevision: 3, values: { typed: "synthetic-pass" }, action: { kind: "submit" } }]);
});

it("opens the next step by itself and closes an unanswered exchange when the step moves on", async () => {
  const host = exchange();
  const first = shot();
  const { container, root } = mount(first, host.openPicture);
  await click(byText(container, "interaction.inputHandoff.picture.open"));
  await act(async () => {
    root.render(
      createElement(InputHandoffPictureStep, {
        key: "next",
        snapshot: { ...first, revision: 5 },
        busy: false,
        openPicture: host.openPicture,
        onDecide: () => {},
        onError: () => {},
      }),
    );
  });
  expect(host.errors).toHaveLength(1);
  expect(host.openPicture).toHaveBeenCalledTimes(2);
  expect(host.openPicture.mock.calls[1]![0]).toMatchObject({ revision: 5 });
  expect(host.answers).toEqual([]);
});

it("goes back to the form without opening anything", async () => {
  const host = exchange();
  const { container, onDecide } = mount(shot(), host.openPicture);
  await click(byText(container, "interaction.inputHandoff.action.backToForm"));
  expect(onDecide).toHaveBeenCalledWith("refresh");
  expect(host.openPicture).not.toHaveBeenCalled();
});

