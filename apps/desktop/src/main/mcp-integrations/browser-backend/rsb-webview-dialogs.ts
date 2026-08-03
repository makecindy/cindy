import type { WebContents } from 'electron';

interface DialogLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface ElectronDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BrowserPageDialog {
  id: string;
  type: string;
  message: string;
  defaultValue?: string;
  openedAt: string;
  closedBy?: 'agent' | 'armed' | 'auto';
}

interface PreparedResponse {
  accept: boolean;
  promptText?: string;
  resolve(dialog: BrowserPageDialog): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface DialogState {
  debugger: ElectronDebugger;
  ownedAttachment: boolean;
  enabled: boolean;
  pending?: BrowserPageDialog;
  recent?: BrowserPageDialog;
  prepared?: PreparedResponse;
  handledIds: Map<string, 'agent' | 'armed'>;
  openingWaiters: Set<{
    resolve(dialog: BrowserPageDialog): void;
    reject(error: Error): void;
  }>;
  messageHandler: (...args: unknown[]) => void;
  detachHandler: (...args: unknown[]) => void;
  destroyedHandler: (...args: unknown[]) => void;
}

const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 60_000;
const DEFAULT_ARM_WAIT_MS = 120_000;
const MAX_ARM_WAIT_MS = 300_000;
const MAX_DIALOG_TEXT = 16_000;
const MAX_PROMPT_TEXT = 32_000;

let dialogSequence = 0;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boundedText(value: unknown, max = MAX_DIALOG_TEXT): string {
  return text(value).slice(0, max);
}

function boundedWait(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_WAIT_MS, Math.floor(value))
    : DEFAULT_WAIT_MS;
}

function boundedArmWait(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(MAX_ARM_WAIT_MS, Math.floor(value))
    : DEFAULT_ARM_WAIT_MS;
}

function debuggerFor(wc: WebContents): ElectronDebugger {
  const candidate = (wc as unknown as { debugger?: ElectronDebugger }).debugger;
  if (!candidate) throw new Error('webContents debugger is unavailable');
  return candidate;
}

/**
 * Tracks JavaScript modal prompts for each embedded page and responds through
 * the page debugger. The monitor releases only attachments it created.
 */
export class RsbWebviewDialogs {
  private readonly states = new Map<WebContents, DialogState>();
  private disposed = false;

  constructor(private readonly logger: DialogLogger) {}

  async observe(wc: WebContents): Promise<void> {
    if (this.disposed) throw new Error('page dialog monitor is disposed');
    let state = this.states.get(wc);
    if (!state) {
      state = this.createState(wc);
      this.states.set(wc, state);
    }
    if (state.enabled && state.debugger.isAttached()) return;
    if (!state.debugger.isAttached()) {
      state.debugger.attach('1.3');
      state.ownedAttachment = true;
    }
    await state.debugger.sendCommand('Page.enable');
    this.assertActive(wc, state);
    state.enabled = true;
  }

  pending(wc: WebContents): BrowserPageDialog | undefined {
    const dialog = this.states.get(wc)?.pending;
    return dialog ? { ...dialog } : undefined;
  }

  recent(wc: WebContents, dialogId?: string, openedAfter?: number): BrowserPageDialog | undefined {
    const dialog = this.states.get(wc)?.recent;
    if (!dialog || (dialogId && dialog.id !== dialogId)) return undefined;
    if (openedAfter !== undefined && Date.parse(dialog.openedAt) < openedAfter) {
      return undefined;
    }
    return { ...dialog };
  }

  watchOpening(wc: WebContents): {
    opened: Promise<BrowserPageDialog>;
    cancel(): void;
  } {
    const state = this.states.get(wc);
    if (!state?.enabled) {
      throw new Error('page dialog monitor is not active');
    }
    this.assertActive(wc, state);
    if (state.pending) {
      return {
        opened: Promise.resolve({ ...state.pending }),
        cancel: () => {},
      };
    }
    let active = true;
    let waiter!: {
      resolve(dialog: BrowserPageDialog): void;
      reject(error: Error): void;
    };
    const opened = new Promise<BrowserPageDialog>((resolve, reject) => {
      waiter = { resolve, reject };
      state.openingWaiters.add(waiter);
    });
    return {
      opened,
      cancel: () => {
        if (!active) return;
        active = false;
        state.openingWaiters.delete(waiter);
      },
    };
  }

  async respond(
    wc: WebContents,
    options: {
      dialogId?: string;
      accept?: boolean;
      promptText?: string;
      timeoutMs?: number;
    },
  ): Promise<BrowserPageDialog & { accepted: boolean; deferred: boolean }> {
    if (options.dialogId && options.dialogId.length > 256) {
      throw new Error('dialogId is too long');
    }
    if (typeof options.promptText === 'string' && options.promptText.length > MAX_PROMPT_TEXT) {
      throw new Error(`promptText exceeds ${MAX_PROMPT_TEXT} characters`);
    }
    await this.observe(wc);
    const state = this.states.get(wc);
    if (!state) throw new Error('page dialog monitor unavailable');
    this.assertActive(wc, state);
    const deadline = Date.now() + boundedWait(options.timeoutMs);
    let dialog: BrowserPageDialog | undefined;
    for (;;) {
      this.assertActive(wc, state);
      const current = state.pending;
      if (current && (!options.dialogId || current.id === options.dialogId)) {
        dialog = current;
        break;
      }
      if (current && options.dialogId && current.id !== options.dialogId) {
        throw new Error(`dialog ${options.dialogId} is no longer pending`);
      }
      const recent = state.recent;
      // An undirected response must wait for a fresh dialog. A recent dialog
      // is only meaningful when the caller explicitly targets its id; using a
      // stale recent record here would prevent arm-next from observing the
      // next dialog.
      if (recent && options.dialogId && recent.id === options.dialogId) {
        return {
          ...recent,
          accepted: options.accept === true,
          deferred: true,
        };
      }
      if (recent && options.dialogId && recent.id !== options.dialogId) {
        throw new Error(`dialog ${options.dialogId} is no longer pending`);
      }
      if (Date.now() >= deadline) throw new Error('no page dialog is pending');
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.assertActive(wc, state);
    }

    const accepted = options.accept === true;
    this.assertActive(wc, state);
    state.handledIds.set(dialog.id, 'agent');
    try {
      this.assertActive(wc, state);
      await state.debugger.sendCommand('Page.handleJavaScriptDialog', {
        accept: accepted,
        ...(accepted && typeof options.promptText === 'string'
          ? { promptText: options.promptText }
          : {}),
      });
      this.assertActive(wc, state);
    } catch (err) {
      state.handledIds.delete(dialog.id);
      throw err;
    }
    // Keep the pending record until Page.javascriptDialogClosed arrives. The
    // close event is the authoritative signal that Chromium finished handling
    // the modal and also records the recent outcome for action coordination.
    return { ...dialog, accepted, deferred: false };
  }

  armNext(
    wc: WebContents,
    options: {
      accept: boolean;
      promptText?: string;
      timeoutMs?: number;
    },
  ): { response: Promise<BrowserPageDialog>; cancel(): void } {
    const state = this.states.get(wc);
    if (!state?.enabled) {
      throw new Error('page dialog monitor is not active');
    }
    this.assertActive(wc, state);
    if (state.prepared) {
      clearTimeout(state.prepared.timer);
      state.prepared.reject(new Error('page dialog response was replaced'));
      state.prepared = undefined;
    }
    let active = true;
    let prepared!: PreparedResponse;
    const response = new Promise<BrowserPageDialog>((resolve, reject) => {
      const timeout = boundedArmWait(options.timeoutMs);
      const timer = setTimeout(() => {
        if (!active || state.prepared !== prepared) return;
        active = false;
        state.prepared = undefined;
        reject(new Error('armed page dialog response expired'));
      }, timeout);
      prepared = {
        accept: options.accept === true,
        ...(typeof options.promptText === 'string' ? { promptText: options.promptText } : {}),
        resolve,
        reject,
        timer,
      };
      state.prepared = prepared;
    });
    return {
      response,
      cancel: () => {
        if (!active || state.prepared !== prepared) return;
        active = false;
        clearTimeout(prepared.timer);
        state.prepared = undefined;
      },
    };
  }

  diagnostics(): { observedTabs: number; pendingDialogs: number } {
    let pendingDialogs = 0;
    for (const state of this.states.values()) {
      if (state.pending) pendingDialogs += 1;
    }
    return { observedTabs: this.states.size, pendingDialogs };
  }

  dispose(): void {
    this.disposed = true;
    for (const wc of [...this.states.keys()]) this.release(wc);
  }

  private createState(wc: WebContents): DialogState {
    const electronDebugger = debuggerFor(wc);
    const state: DialogState = {
      debugger: electronDebugger,
      ownedAttachment: false,
      enabled: false,
      openingWaiters: new Set(),
      handledIds: new Map(),
      messageHandler: () => {},
      detachHandler: () => {},
      destroyedHandler: () => {},
    };
    state.messageHandler = (...args: unknown[]) => {
      try {
        if (this.disposed || this.states.get(wc) !== state) return;
        const method = text(args[1]);
        const params =
          args[2] && typeof args[2] === 'object' ? (args[2] as Record<string, unknown>) : {};
        if (method === 'Page.javascriptDialogOpening') {
          dialogSequence += 1;
          const dialog: BrowserPageDialog = {
            id: `page-dialog-${Date.now().toString(36)}-${dialogSequence.toString(36)}`,
            type: boundedText(params.type, 64) || 'alert',
            message: boundedText(params.message),
            ...(boundedText(params.defaultPrompt)
              ? { defaultValue: boundedText(params.defaultPrompt) }
              : {}),
            openedAt: new Date().toISOString(),
          };
          state.pending = dialog;
          for (const waiter of state.openingWaiters) {
            waiter.resolve({ ...dialog });
          }
          state.openingWaiters.clear();
          const prepared = state.prepared;
          if (prepared) {
            state.prepared = undefined;
            clearTimeout(prepared.timer);
            state.handledIds.set(dialog.id, 'armed');
            this.assertActive(wc, state);
            void state.debugger
              .sendCommand('Page.handleJavaScriptDialog', {
                accept: prepared.accept,
                ...(prepared.accept && typeof prepared.promptText === 'string'
                  ? { promptText: prepared.promptText }
                  : {}),
              })
              .then(
                () => prepared.resolve({ ...dialog, closedBy: 'armed' }),
                (err) => prepared.reject(err instanceof Error ? err : new Error(String(err))),
              );
          }
        } else if (method === 'Page.javascriptDialogClosed') {
          const dialog = state.pending;
          if (dialog) {
            const closedBy = state.handledIds.get(dialog.id) ?? 'auto';
            state.handledIds.delete(dialog.id);
            state.recent = { ...dialog, closedBy };
          }
          state.pending = undefined;
        }
      } catch (err) {
        this.logger.warn('RSB page dialog event handler failed', err);
      }
    };
    state.detachHandler = () => {
      state.enabled = false;
      state.ownedAttachment = false;
    };
    state.destroyedHandler = () => this.release(wc);
    electronDebugger.on('message', state.messageHandler);
    electronDebugger.on('detach', state.detachHandler);
    (
      wc as unknown as {
        once?: (event: string, listener: (...args: unknown[]) => void) => void;
      }
    ).once?.('destroyed', state.destroyedHandler);
    return state;
  }

  private assertActive(wc: WebContents, state: DialogState): void {
    if (this.disposed || this.states.get(wc) !== state) {
      throw new Error('page dialog monitor is disposed');
    }
  }

  private release(wc: WebContents): void {
    const state = this.states.get(wc);
    if (!state) return;
    this.states.delete(wc);
    try {
      state.debugger.removeListener('message', state.messageHandler);
      state.debugger.removeListener('detach', state.detachHandler);
      (
        wc as unknown as {
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        }
      ).removeListener?.('destroyed', state.destroyedHandler);
    } catch {
      // The guest may already be destroyed.
    }
    if (state.prepared) {
      clearTimeout(state.prepared.timer);
      state.prepared.reject(new Error('page dialog monitor was released'));
      state.prepared = undefined;
    }
    for (const waiter of state.openingWaiters) {
      waiter.reject(new Error('page dialog monitor was released'));
    }
    state.openingWaiters.clear();
    if (state.ownedAttachment) {
      try {
        if (state.debugger.isAttached()) state.debugger.detach();
      } catch {
        // Detach is best effort during teardown.
      }
    }
  }
}
