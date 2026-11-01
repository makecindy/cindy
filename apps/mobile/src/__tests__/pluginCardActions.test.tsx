// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginCardActions } from "../plugins/PluginCardActions";
import { pendingGhostCardFormDelivery } from "@cindy/maker-shared/ghost-card-form";
import { MobileMailHtmlPreview } from '../plugins/MobileMailHtmlPreview';

vi.mock('react-native-webview', () => ({ WebView: forwardRef((props: any, ref) => {
  h.web = props;
  useImperativeHandle(ref, () => ({ injectJavaScript: h.inject }));
  return createElement('div', { 'data-testid': 'html-preview', 'data-html': props.source.html });
}) }));
vi.mock("@/auth/AuthContext", () => ({ useAuth: () => ({ getAccessToken: async () => 'test-token' }) }));
vi.mock("../plugins/mobileMailAttachment", () => ({ pickMobileMailAttachment: (...args: unknown[]) => h.pick(...args) }));
vi.mock("@/session/useBotGroupRemoteMedia", () => ({ useBotGroupRemoteMedia: () => h.resolve }));
vi.mock('@/components/FileTypeIcon', () => ({ FileTypeIcon: () => null }));

const h = vi.hoisted(() => ({ invoke: vi.fn(), pick: vi.fn(), resolve: vi.fn(), inject: vi.fn(), web: {} as any, mode: 'light' }));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) =>
    createElement("div", {}, children);
  return {
    View,
    KeyboardAvoidingView: View,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress(): void;
      disabled: boolean;
    }) => createElement("button", { onClick: onPress, disabled }, children),
    Modal: ({
      children,
      visible,
    }: {
      children?: ReactNode;
      visible: boolean;
    }) => (visible ? createElement("div", {}, children) : null),
    Platform: { OS: "ios" },
    StyleSheet: { create: (value: unknown) => value },
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove: () => {} }),
    },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
    Keyboard: { addListener: () => ({ remove: () => {} }) },
  };
});
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: { children?: ReactNode }) =>
    createElement("span", {}, children),
  TextInput: ({
    value,
    onChangeText,
    editable,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText(value: string): void;
    editable?: boolean;
    accessibilityLabel?: string;
  }) =>
    createElement("textarea", {
      value,
      disabled: editable === false,
      "aria-label": accessibilityLabel,
      onInput: (event: React.FormEvent<HTMLTextAreaElement>) =>
        onChangeText(event.currentTarget.value),
      onChange: () => {},
    }),
}));
vi.mock("@/theme", async () => ({
  ...(await import("../theme/tokens")),
  useThemedStyles: () => ({}),
  useTheme: () => ({ mode: h.mode, colors: { surface: '#181818', textPrimary: '#eeeeee' } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ invoke: h.invoke, status: "online" }),
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => ({ accountKey: "owner" }),
  isMobileAuthOwnerCurrent: () => true,
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  h.mode = 'light';
  vi.clearAllMocks();
});
describe("native plugin card deliberate actions", () => {
  // Mobile parity regression: typing must use the real form delivery, update
  // both MIME alternatives and retain the authored HTML/CID bytes (unit).
  it('autosaves direct HTML typing through the shared card without reloading the editing document', async () => {
    const dispatch = vi.fn(async (_input: unknown) => ({ effects: [] }));
    h.invoke.mockImplementation(async (_d: string, _c: string, args: any[]) => {
      if (args[0].collectionId === 'plugin-results') return dispatch(args[0]);
      if (args[0].actionId === 'open-interaction') return { result: { pageId: 'page' } };
      return { result: { confirms: [] } };
    });
    const container = document.createElement('div'), root = createRoot(container);
    unmount = () => act(() => root.unmount());
    const key = '12345678-1234-1234-1234-123456789abc';
    const html = '<style>p{color:red}</style><p>Hello</p><img src="cid:card">';
    const fields = [...['to','cc','bcc','subject','body'].map(name => ({ name, label: name, value: '', kind: 'hidden' })),
      { name: 'bodyHtml', label: 'HTML', kind: 'mail-html', value: html }];
    await act(async () => root.render(createElement(PluginCardActions, { deviceId: 'device', sessionId: 's', callId: 'text', data: {
      pluginId: 'mail', revision: '1', form: fields, changeAction: `mail:change:${key}`, items: [],
      mail: { key, accountId: 'a', draftId: 'd', from: '', fields, state: 'draft', status: 'Draft', sendLabel: 'Send', fromLabel: 'From', attachments: [] },
    } })));
    const source = h.web.source;
    expect(source.html).toContain("script-src 'none'");
    expect(container.textContent).not.toContain('plugins.mailEditText');
    expect(container.querySelector('textarea')).toBeNull();
    const message = (data: unknown) => h.web.onMessage({ nativeEvent: { data: JSON.stringify(data) } });
    await act(async () => {
      message({ type: 'mail-text', documentId: 99, id: '0', text: 'stale' });
      message({ type: 'mail-text', documentId: 0, id: '99', text: 'forged' });
    });
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => {
      message({ type: 'mail-text', documentId: 0, id: '0', text: '你好\nCherry' });
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ formValues: expect.objectContaining({
      body: '你好\nCherry', bodyHtml: '<style>p{color:red}</style><p>你好<br>Cherry</p><img src="cid:card">',
    }) }) }));
    expect(h.web.source).toBe(source);
    expect(h.web.source.html).toContain("script-src 'none'");
  });
  // Inline images must not duplicate attachment tiles; ordinary files remain
  // removable. Exercise real form delivery while preserving the inline MIME part.
  it('opens an image and hides its attachment tile after insertion while retaining its MIME part and head styles', async () => {
    const dispatch = vi.fn(async (_input: unknown) => ({ effects: [] })), open = vi.fn();
    h.invoke.mockImplementation(async (_d: string, _c: string, args: any[]) => {
      if (args[0].collectionId === 'plugin-results') return dispatch(args[0]);
      if (args[0].actionId === 'open-interaction') return { result: { pageId: 'page' } };
      return { result: { confirms: [] } };
    });
    const container = document.createElement('div'), root = createRoot(container);
    unmount = () => act(() => root.unmount());
    const url = `cindy-media://blobs/${'a'.repeat(64)}.png`, key = '12345678-1234-1234-1234-123456789abc';
    const fields = [...['to','cc','bcc','subject','body'].map(name => ({ name, label: name, value: '' })),
      { name: 'bodyHtml', label: 'HTML', kind: 'hidden', value: '<style>.card{color:red}</style><p>Keep</p>' },
      { name: 'attachmentItems', label: 'Files', kind: 'mail-attachments', value: JSON.stringify([
        { key: 'image', filename: 'photo.png', mimeType: 'image/png', previewUrl: url, bytes: 1000 },
        { key: 'pdf', filename: 'notes.pdf', mimeType: 'application/pdf' },
      ]) }];
    await act(async () => root.render(createElement(PluginCardActions, { deviceId: 'device', sessionId: 's', callId: 'image', onOpenAttachment: open, data: {
      pluginId: 'mail', revision: '1', form: fields, changeAction: `mail:change:${key}`, items: [],
      mail: { key, accountId: 'a', draftId: 'd', from: '', fields, state: 'draft', status: 'Draft', sendLabel: 'Send', fromLabel: 'From', attachments: [] },
    } })));
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('photo.png'))!.click());
    expect(open).toHaveBeenCalledWith(url, 'photo.png');
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'plugins.mailInsertImage')!.click());
    const inserted = dispatch.mock.calls.at(-1)![0] as any;
    expect(inserted.input.formValues.bodyHtml).toContain('src="cid:image-1@cindy.local"');
    expect(inserted.input.formValues.bodyHtml).not.toContain('cindy-media:');
    expect(JSON.parse(inserted.input.formValues.attachmentItems)).toHaveLength(2);
    expect(container.textContent).not.toContain('plugins.mailInsertImage');
    expect(container.textContent).not.toContain('photo.png');
    expect(container.textContent).toContain('notes.pdf');
    expect(inserted.input.formValues.bodyHtml).toContain('<style>.card{color:red}</style>');
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === '×')!.click());
    const removed = (dispatch.mock.calls.at(-1)![0] as any).input.formValues;
    expect(JSON.parse(removed.attachmentItems).map((file: any) => file.key)).toEqual(['image']);
    expect(removed.bodyHtml).toBe(inserted.input.formValues.bodyHtml);
    expect(container.textContent).not.toContain('notes.pdf');
  });
  it('resolves inline images for an inert phone preview and keeps the saved CID HTML intact', async () => {
    const container = document.createElement('div'), root = createRoot(container);
    unmount = () => act(() => root.unmount());
    const html = '<p>Hello</p><img src="cid:logo">';
    h.resolve.mockResolvedValue({ url: 'data:image/png;base64,aGVsbG8=', previewable: true });
    await act(async () => root.render(createElement(MobileMailHtmlPreview, {
      html, deviceId: 'device', images: [{ cid: 'logo', url: `cindy-media://blobs/${'a'.repeat(64)}.png` }],
    })));
    const preview = container.querySelector('[data-testid="html-preview"]')!;
    expect(h.inject.mock.calls.some(([script]) => script.includes('data:image/png;base64,aGVsbG8='))).toBe(true);
    expect(preview.getAttribute('data-html')).toContain("script-src 'none'");
    expect(preview.getAttribute('data-html')).not.toMatch(/data-cindy-mail-run|pre-wrap/);
    expect(html).toContain('src="cid:logo"');
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it('repaints native reading colors on theme changes without replacing the document or changing mail', async () => {
    const container = document.createElement('div'), root = createRoot(container);
    unmount = () => act(() => root.unmount());
    const html = '<p style="background:rgb(249,154,60);color:black">Ticket</p><section style="background:linear-gradient(#fff,#eee);color:#000">Gradient</section>';
    const render = () => act(async () => root.render(createElement(MobileMailHtmlPreview, { html, deviceId: 'device' })));
    await render();
    const source = h.web.source;
    const frame = document.createElement('iframe'); document.body.append(frame);
    try {
      const doc = frame.contentDocument!;
      doc.open(); doc.write(source.html); doc.close();
      const view = Object.assign(doc.defaultView!, { ReactNativeWebView: { postMessage: () => undefined } });
      // Height fitting needs real layout; this test covers color repainting only.
      h.inject.mockImplementation(script => new Function('document', 'window', 'getComputedStyle', 'requestAnimationFrame', 'setTimeout', script)(doc, view, view.getComputedStyle.bind(view), () => 0, () => 0));
      for (const mode of ['dark', 'light', 'dark']) {
        h.mode = mode;
        await render();
        expect(h.web.source).toBe(source);
        expect(doc.querySelector('p')!.style.backgroundColor).toBe(mode === 'dark' ? 'rgb(129, 71, 14)' : 'rgb(249, 154, 60)');
        expect(doc.querySelector('section')!.style.backgroundImage).toBe(mode === 'dark' ? 'none' : 'linear-gradient(rgb(255, 255, 255), rgb(238, 238, 238))');
        expect(doc.querySelector('[data-cindy-mail-run]')).toBeNull();
      }
      expect(h.invoke).not.toHaveBeenCalled();
    } finally { h.inject.mockReset(); frame.remove(); }
  });
  it('uploads from the phone then attaches to the same card; cancellation never dispatches', async () => {
    const dispatch = vi.fn(async (_input: unknown) => ({ effects: [] }));
    h.invoke.mockImplementation(async (_device: string, _channel: string, args: any[]) => {
      if (args[0].collectionId === 'plugin-results') return dispatch(args[0]);
      if (args[0].actionId === 'open-interaction') return { result: { pageId: 'page' } };
      return { result: { confirms: [] } };
    });
    const container = document.createElement('div'), root = createRoot(container);
    unmount = () => act(() => root.unmount());
    const key = '12345678-1234-1234-1234-123456789abc';
    const fields = [...['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name })),
      { name: 'attachmentItems', label: 'Files', value: '[]', kind: 'mail-attachments' }];
    await act(async () => root.render(createElement(PluginCardActions, { deviceId: 'device', sessionId: 's', callId: 'upload', data: {
      pluginId: 'mail', revision: '1', form: fields, mailUpload: true, changeAction: `mail:change:${key}`, items: [],
      mail: { accountId: 'a', draftId: 'd', key, from: 'a@example.test', fields, state: 'draft', status: 'Draft',
        sendLabel: 'Send', fromLabel: 'From', attachments: [] },
    } })));
    const button = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'plugins.mailAttach')!;
    h.pick.mockResolvedValueOnce(null);
    await act(async () => button().click());
    expect(dispatch).not.toHaveBeenCalled();
    const upload = { url: 'xdt-attach-oss://test-reference', name: 'plan.pdf' };
    h.pick.mockImplementationOnce(async ({ deliver }: { deliver(file: typeof upload): Promise<boolean> }) => {
      await deliver(upload);
      return upload;
    });
    await act(async () => button().click());
    expect(h.pick).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: 'device', isActive: expect.any(Function) }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ actionId: `mail:attach:${key}`,
      input: expect.objectContaining({ mailAttachment: upload, formValues: expect.objectContaining({ subject: 'subject' }) }) }));
  });
  it('deletes without saving fields and replaces the editor with a compact status and subject', async () => {
    const dispatch = vi.fn(async (_input: unknown) => ({ effects: [] }));
    h.invoke.mockImplementation(async (_device: string, _channel: string, args: any[]) => {
      if (args[0].collectionId === 'plugin-results') return dispatch(args[0]);
      if (args[0].actionId === 'open-interaction') return { result: { pageId: 'page' } };
      return { result: { confirms: [] } };
    });
    const container = document.createElement('div'), root = createRoot(container);
    unmount = () => act(() => root.unmount());
    const key = '12345678-1234-1234-1234-123456789abc';
    const fields = ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name }));
    const id = `mail:delete:${key}`;
    const render = (state: 'draft' | 'deleted') => root.render(createElement(PluginCardActions, {
      deviceId: 'device', sessionId: 's', callId: 'delete', data: {
        pluginId: 'mail', revision: state, form: fields, items: [{ id, label: 'Delete draft', disabled: false }],
        mail: { accountId: 'a', draftId: 'd', key, from: 'a@example.test', fields, state, status: state,
          sendLabel: 'Send', fromLabel: 'From', deleteLabel: 'Delete draft', attachments: [] },
      },
    }));
    await act(async () => render('draft'));
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Delete draft')!.click());
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ actionId: id }));
    expect(dispatch.mock.calls[0][0]).not.toHaveProperty('input.formValues');
    await act(async () => render('deleted'));
    expect(container.querySelectorAll('textarea,button')).toHaveLength(0);
    expect(container.textContent).toContain('deleted');
    expect(container.textContent).toContain('subject');
    expect(container.textContent).not.toContain('body');
    expect(container.textContent).not.toContain('a@example.test');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'now'])('allows %s during a locked send countdown without resubmitting fields', async (operation) => {
    const dispatch = vi.fn(async (_input: unknown) => ({ effects: [] }));
    h.invoke.mockImplementation(async (_device: string, _channel: string, args: any[]) => {
      if (args[0].collectionId === 'plugin-results') return dispatch(args[0]);
      if (args[0].actionId === 'open-interaction') return { result: { pageId: 'page' } };
      return { result: { confirms: [] } };
    });
    const container = document.createElement('div'), root = createRoot(container);
    unmount = () => act(() => root.unmount());
    const key = '12345678-1234-1234-1234-123456789abc';
    const fields = ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name }));
    const id = `mail:${operation}:${key}`;
    await act(async () => root.render(createElement(PluginCardActions, { deviceId: 'device', sessionId: 's', callId: 'waiting', data: {
      pluginId: 'mail', revision: '1', form: fields, items: [{ id, label: operation, disabled: false }],
      mail: { accountId: 'a', draftId: 'd', key, from: 'a@example.test', fields, state: 'sending', status: 'Waiting',
        sendLabel: 'Send', fromLabel: 'From', attachments: [], pendingSend: { deadline: Date.now() + 10000, label: '{seconds}s', cancelLabel: 'cancel', sendNowLabel: 'now' } },
    } })));
    expect([...container.querySelectorAll('textarea')].every(el => el.disabled)).toBe(true);
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === operation)!.click());
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ actionId: id }));
    expect(dispatch.mock.calls[0][0]).not.toHaveProperty('input.formValues');
  });
  it("publishes edits without a click and keeps newer typing through an autosave card update", async () => {
    const dispatch = vi.fn(async (_input: unknown) => ({ effects: [] }));
    h.invoke.mockImplementation(
      async (_device: string, _channel: string, args: any[]) => {
        if (args[0].collectionId === "plugin-results")
          return dispatch(args[0].input);
        if (args[0].actionId === "open-interaction")
          return { result: { pageId: "page" } };
        return { result: { confirms: [] } };
      },
    );
    const container = document.createElement("div"),
      root = createRoot(container);
    unmount = () => act(() => root.unmount());
    const renderCard = (revision: string, value: string) =>
      root.render(
        createElement(PluginCardActions, {
          deviceId: "device",
          sessionId: "edit-task",
          callId: "card",
          data: {
            pluginId: "practice",
            revision,
            changeAction: "change:one",
            form: [
              {
                name: "to",
                label: "To",
                value: "Jane <jane@example.test>, Rigo <rigo@example.test>",
                kind: "recipients",
                row: "recipients",
              },
              {
                name: "cc",
                label: "Cc",
                value: "Emma <emma@example.test>",
                kind: "recipients",
                row: "recipients",
              },
              { name: "bcc", label: "Bcc", value: "Hidden <hidden@example.test>", kind: "recipients", collapsed: true },
              { name: "body", label: "Message", value, multiline: true },
            ],
            items: [
              { id: "send", label: "Send", submit: true, disabled: false },
            ],
          },
        }),
      );
    await act(async () => renderCard("one", "Initial"));
    expect(container.textContent).not.toContain("Bcc");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "plugins.expandFields")!
        .click(),
    );
    expect(
      [...container.querySelectorAll("span")].filter(
        (el) => el.textContent === "To",
      ),
    ).toHaveLength(1);
    expect(container.querySelector('textarea[aria-label="Bcc"]')).toBeTruthy();
    const cc = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Cc"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(cc, "Latest <latest@example.test>");
      cc.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "Latest edit");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const barrier = pendingGhostCardFormDelivery(
        JSON.stringify(["device", "edit-task"]),
      );
      expect(barrier).toBeDefined();
      expect(await barrier).toBe(true);
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        formChange: true,
        formValues: expect.objectContaining({
          body: "Latest edit",
          cc: "Latest <latest@example.test>",
          bcc: "Hidden <hidden@example.test>",
        }),
      }),
    );
    expect(input.disabled).toBe(false);
    await act(async () => renderCard("two", "Older autosave receipt"));
    expect(input.value).toBe("Latest edit");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Send")!
        .click(),
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        formKey: "change:one",
        formValues: expect.objectContaining({
          body: "Latest edit",
          cc: "Latest <latest@example.test>",
          bcc: "Hidden <hidden@example.test>",
        }),
      }),
    );
  });
  it("submits edited text and holds all fields until the card revision changes", async () => {
    const dispatch = vi.fn(async (_input: unknown) => ({ effects: [] }));
    h.invoke.mockImplementation(
      async (_device: string, _channel: string, args: any[]) => {
        if (args[0].collectionId === "plugin-results")
          return dispatch(args[0].input);
        if (args[0].actionId === "open-interaction")
          return { result: { pageId: "page" } };
        if (args[0].actionId === "poll") return { result: { confirms: [] } };
        return { effects: [] };
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    const renderCard = (revision: string, value: string) =>
      root.render(
        createElement(PluginCardActions, {
          deviceId: "device",
          sessionId: "session",
          callId: "call",
          data: {
            pluginId: "practice",
            revision,
            form: [{ name: "body", label: "Message", value, multiline: true }],
            items: [
              { id: "send", label: "Send", disabled: false, submit: true },
            ],
          },
        }),
      );
    await act(async () => renderCard("one", "Initial"));
    expect(container.textContent).not.toContain("Bcc");
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "Edited\n\nMessage");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => renderCard("one", "Initial"));
    expect(container.textContent).not.toContain("Bcc");
    expect(input.value).toBe("Edited\n\nMessage");
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ formValues: { body: "Edited\n\nMessage" } }),
    );
    expect(button.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    await act(async () => button.click());
    expect(dispatch).toHaveBeenCalledTimes(1);
    await act(async () => renderCard("two", "Saved reply"));
    expect(input.value).toBe("Saved reply");
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
  });
  it.each([false, true])(
    "releases only a known successful delivery (unknown=%s)",
    async (unknown) => {
      const dispatch = vi.fn(async () => {
        if (unknown) throw new Error("lost receipt");
        return { effects: [] };
      });
      h.invoke.mockImplementation(
        async (_device: string, _channel: string, args: any[]) => {
          if (args[0].collectionId === "plugin-results") return dispatch();
          if (args[0].actionId === "open-interaction")
            return { result: { pageId: "page" } };
          if (args[0].actionId === "poll") return { result: { confirms: [] } };
          return { effects: [] };
        },
      );
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      unmount = () => {
        act(() => root.unmount());
        container.remove();
      };
      await act(async () =>
        root.render(
          createElement(PluginCardActions, {
            deviceId: "device",
            sessionId: "session",
            callId: "call",
            data: {
              pluginId: "practice",
              revision: "unchanged",
              items: [{ id: "again", label: "Again", disabled: false }],
            },
          }),
        ),
      );
      const button = container.querySelector("button")!;
      await act(async () => button.click());
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(unknown);
      await act(async () => button.click());
      expect(dispatch).toHaveBeenCalledTimes(unknown ? 1 : 2);
    },
  );
});

it('hides empty recipient add controls in sent mail but keeps existing addresses readable', async () => {
  const container = document.createElement('div'), root = createRoot(container);
  unmount = () => act(() => root.unmount());
  const fields = [
    { name: 'to', label: 'To', value: 'to@example.test', kind: 'recipients' as const },
    { name: 'cc', label: 'Cc', value: '', kind: 'recipients' as const },
    { name: 'bcc', label: 'Bcc', value: 'hidden@example.test', kind: 'recipients' as const, collapsed: true },
    { name: 'subject', label: 'Subject', value: 'Sent mail' },
    { name: 'body', label: 'Message', value: 'Sent body', multiline: true },
  ];
  await act(async () => root.render(createElement(PluginCardActions, { deviceId: 'device', sessionId: 's', callId: 'sent', data: {
    pluginId: 'mail', revision: '1', form: fields, items: [],
    mail: { accountId: 'a', draftId: 'd', key: '12345678-1234-1234-1234-123456789abc', from: 'a@example.test', fields,
      state: 'sent', status: 'Sent', sendLabel: 'Send', fromLabel: 'From', attachments: [] },
  } })));
  expect(container.textContent).not.toContain('Cc');
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'plugins.expandFields')!.click());
  expect(container.querySelector('textarea[aria-label="Cc"]')).toBeNull();
  const bcc = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Bcc"]')!;
  expect(bcc.value).toBe('hidden@example.test');
  expect(bcc.disabled).toBe(true);
  expect(h.invoke).not.toHaveBeenCalled();
});

it('hides superseded mail entirely instead of showing another draft-updated card', async () => {
  const container = document.createElement('div'), root = createRoot(container);
  unmount = () => act(() => root.unmount());
  const fields = ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name === 'body' ? 'Historical body' : name }));
  await act(async () => root.render(createElement(PluginCardActions, { deviceId: 'device', sessionId: 's', callId: 'old', data: {
    pluginId: 'mail', revision: '1', form: fields, items: [{ id: 'send', label: 'Send', disabled: false }],
    mail: { accountId: 'a', draftId: 'd', key: '12345678-1234-1234-1234-123456789abc', from: 'a@example.test', fields,
      state: 'draft', status: 'Saved', sendLabel: 'Send', fromLabel: 'From', attachments: [], supersededBy: 'new' },
  } })));
  expect(container.innerHTML).toBe('');
  expect(h.invoke).not.toHaveBeenCalled();
});
