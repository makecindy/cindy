import path from 'node:path';
import { createRequire } from 'node:module';
import { app, BrowserWindow, type WebContents } from 'electron';
import { isNativeTrackpadFrame, type NativeTrackpadFrame } from '../shared/nativeTrackpad';
import { createLogger } from './logger';

interface NativeInput {
  start(handle: Buffer, callback: (frame: string) => void): number | null;
  stop(id: number): void;
  position?(handle: Buffer): Point | null;
}
interface Point {
  x: number;
  y: number;
}
interface Rect extends Point {
  width: number;
  height: number;
}
interface Contact extends Point {
  id: number;
  radiusX: number;
  radiusY: number;
  force: number;
}
// One native sample stays one DOM event. Chromium's touch injection otherwise
// splits the initial pair into 1/2 contacts and delays moves until input ACK.
const deliverContacts = `function(frame, anchor) {
  if (frame.phase !== 'cancel') {
    if (!this.isConnected || this.getAttribute('data-cindy-trackpad') !== 'contacts') return false;
    if (frame.phase === 'begin' &&
        this.getRootNode().elementFromPoint(anchor.x, anchor.y)?.closest('[data-cindy-trackpad]') !== this)
      return false;
  }
  this.dispatchEvent(new CustomEvent('cindy-trackpad', {detail: frame}));
  return true;
}`;
const requireNative = createRequire(__filename);
const log = createLogger('nativeTrackpad');
let native: NativeInput | null | undefined;
function load(): NativeInput | null {
  if (native !== undefined) return native;
  try {
    const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
    native = requireNative(path.join(base, 'tools/trackpad/cindy-trackpad.node')) as NativeInput;
  } catch {
    log.warn('Native trackpad unavailable; retaining wheel gestures');
    native = null;
  }
  return native;
}
const inside = (r: Rect, p: Point) =>
  p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/** Opt-in native input. CDP hit testing crosses iframe origins without opening
 * a JS/IPC bridge in the ghost sandbox. Only focused/key-window input is sent. */
export function installNativeTrackpad(
  host: WebContents,
  guest: WebContents,
  isCurrent = () => true,
  deps = {
    platform: process.platform as string,
    load,
    window: (wc: WebContents) => BrowserWindow.fromWebContents(wc),
  },
): void {
  if (deps.platform !== 'darwin') return;
  let enabled = false,
    attached = false,
    locating = false,
    epoch = 0;
  let documentEpoch = 0;
  let capture: number | null = null,
    bridge: NativeInput | null = null,
    rect: Rect | null = null;
  let pointer: Point = { x: 0, y: 0 };
  const frames = new Map<string, string>();
  let surface: { objectId: string; session?: string; offset: Point } | null = null;
  let pointerRead = 0;
  let gesture: {
    centre: Point;
    anchor: Point;
    ratio: number;
    distance: number;
    points: Contact[];
    raw: NativeTrackpadFrame['touches'];
  } | null = null;
  const current = () => {
    try {
      return !guest.isDestroyed() && !host.isDestroyed() && isCurrent() && guest.isFocused();
    } catch {
      return false;
    }
  };
  const cancelTouches = () => {
    const pending =
      gesture && attached && !guest.isDestroyed()
        ? surface
          ? dispatchContacts('cancel', [])
          : guest.debugger
              .sendCommand('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
              .catch(() => {})
        : Promise.resolve();
    gesture = null;
    return pending;
  };
  const stop = () => {
    epoch++;
    pointerRead++;
    if (capture !== null) bridge?.stop(capture);
    capture = null;
    rect = null;
    const cancelled = cancelTouches();
    const previous = surface;
    surface = null;
    if (previous && attached && !guest.isDestroyed())
      return cancelled
        .then(() =>
          guest.debugger.sendCommand(
            'Runtime.releaseObject',
            { objectId: previous.objectId },
            previous.session,
          ),
        )
        .then(() => {})
        .catch(() => {});
    return cancelled;
  };
  const dispatchContacts = (phase: string, points: Contact[]) => {
    const target = surface!;
    return guest.debugger
      .sendCommand(
        'Runtime.callFunctionOn',
        {
          objectId: target.objectId,
          functionDeclaration: deliverContacts,
          returnByValue: true,
          arguments: [
            {
              value: {
                phase,
                touches: points.map((p) => ({
                  id: p.id,
                  x: p.x - target.offset.x,
                  y: p.y - target.offset.y,
                })),
              },
            },
            { value: { x: pointer.x - target.offset.x, y: pointer.y - target.offset.y } },
          ],
        },
        target.session,
      )
      .then((reply) => {
        if (reply.exceptionDetails) throw new Error('Native trackpad target execution failed');
        if (reply.result?.value !== true && surface === target) {
          // Same-document replacement, removed opt-in or an overlay can leave
          // the cached object alive but unable to receive this sequence.
          // Cancel even on a disconnected node, then reuse normal hit testing.
          void stop();
          void locate();
        }
      })
      .catch(() => {
        // Clear the gesture before teardown so a failed cancel cannot recurse.
        if (surface === target) {
          gesture = null;
          detach();
        }
      });
  };
  const detach = () => {
    const cancelled = stop(),
      stamp = epoch;
    // Deliver the release before closing CDP. A new capture supersedes teardown.
    void cancelled.then(() => {
      if (stamp !== epoch) return;
      frames.clear();
      if (attached && !guest.isDestroyed()) {
        attached = false;
        guest.debugger.detach();
      }
    });
  };
  const send = (packet: NativeTrackpadFrame, stamp: number) => {
    if (stamp !== epoch) return;
    if (!current() || !rect) {
      stop();
      return;
    }
    if (packet.phase === 'cancel') {
      void cancelTouches();
      return;
    }
    if (packet.phase === 'begin') {
      log.debug('Native contact sequence began', { guestId: guest.id });
      const [a, b] = packet.touches;
      gesture = {
        centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        anchor: { ...pointer },
        ratio: packet.height! / packet.width!,
        // Use the long edge for both axes: portrait viewers otherwise shrink
        // all motion to their narrow width. One uniform scale preserves each
        // finger, pinch ratios and angles; do not accelerate only the centroid.
        distance: Math.max(rect.width, rect.height),
        points: [],
        raw: [],
      };
    }
    if (!gesture) return;
    const g = gesture,
      r = rect,
      clip = (v: number, min: number, max: number) => Math.max(min + 0.5, Math.min(max - 0.5, v));
    const touchPoints = packet.touches.map((p) => {
      const previous = g.points.find((t) => t.id === p.id);
      const raw = g.raw.find((t) => t.id === p.id);
      // Consume movement at the boundary instead of accumulating an invisible
      // overshoot. Even a tiny reversal then moves the contact immediately.
      const origin = previous && raw ? previous : g.anchor;
      const from = previous && raw ? raw : g.centre;
      return {
        id: p.id,
        x: clip(origin.x + (p.x - from.x) * g.distance, r.x, r.x + r.width),
        y: clip(origin.y + (p.y - from.y) * g.distance * g.ratio, r.y, r.y + r.height),
        radiusX: 1,
        radiusY: 1,
        force: 1,
      };
    });
    g.raw = packet.touches;
    // Current Chromium's WebTouch path names released IDs for partial lifts;
    // an active-point touchMove does not release the missing finger there.
    // A complete end uses the protocol's empty list (as does cancellation).
    const released = g.points.filter((p) => !touchPoints.some((t) => t.id === p.id));
    const type =
      packet.phase === 'begin'
        ? 'touchStart'
        : packet.phase === 'end' || released.length
          ? 'touchEnd'
          : 'touchMove';
    g.points = touchPoints;
    if (packet.phase === 'end') gesture = null;
    if (surface) {
      void dispatchContacts(packet.phase, touchPoints);
      return;
    }
    void guest.debugger
      .sendCommand('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' && touchPoints.length ? released : touchPoints,
      })
      .catch(() => {
        if (stamp === epoch) detach();
      });
  };
  const locate = async () => {
    if (!enabled || locating || !current()) return;
    if (rect && inside(rect, pointer) && capture !== null) return;
    stop();
    const win = deps.window(host);
    if (!win || !win.isFocused() || !win.isVisible()) return;
    bridge = deps.load();
    if (!bridge) return;
    if (!attached) {
      // Never borrow or detach another feature's debugger session.
      if (guest.debugger.isAttached()) return;
      try {
        guest.debugger.attach('1.3');
        attached = true;
      } catch {
        return;
      }
    }
    locating = true;
    const stamp = epoch,
      point = { ...pointer };
    const objects: { objectId: string; session?: string }[] = [];
    try {
      await guest.debugger.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      let session: string | undefined,
        offset = { x: 0, y: 0 },
        surfaceId: string | undefined;
      // An out-of-process iframe is a separate CDP target. Hit-test down the
      // visible frame chain, retaining offsets in the guest's viewport space.
      for (let depth = 0; depth < 8; depth++) {
        const hit = await guest.debugger.sendCommand(
          'DOM.getNodeForLocation',
          {
            x: Math.round(point.x - offset.x),
            y: Math.round(point.y - offset.y),
            includeUserAgentShadowDOM: true,
          },
          session,
        );
        const resolved = await guest.debugger.sendCommand(
          'DOM.resolveNode',
          { backendNodeId: hit.backendNodeId },
          session,
        );
        const objectId = resolved.object?.objectId;
        if (!objectId) return;
        objects.push({ objectId, session });
        const surface = await guest.debugger.sendCommand(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration:
              'function(){return this.closest?.("[data-cindy-trackpad]")||null;}',
          },
          session,
        );
        surfaceId = surface.result?.objectId;
        if (surfaceId) {
          objects.push({ objectId: surfaceId, session });
          break;
        }
        const { node } = await guest.debugger.sendCommand(
          'DOM.describeNode',
          { backendNodeId: hit.backendNodeId },
          session,
        );
        if (node?.nodeName !== 'IFRAME' || !node.frameId) return;
        const { model } = await guest.debugger.sendCommand(
          'DOM.getBoxModel',
          { objectId },
          session,
        );
        if (!model?.content) return;
        offset = { x: offset.x + model.content[0], y: offset.y + model.content[1] };
        const child = frames.get(node.frameId);
        if (!child) return;
        session = child;
        await guest.debugger.sendCommand(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          session,
        );
      }
      if (!surfaceId) return;
      const { model } = await guest.debugger.sendCommand(
        'DOM.getBoxModel',
        { objectId: surfaceId },
        session,
      );
      const q = model?.content;
      if (!Array.isArray(q) || q.length !== 8 || q.some((v) => !Number.isFinite(v))) return;
      const xs = [q[0], q[2], q[4], q[6]],
        ys = [q[1], q[3], q[5], q[7]];
      const candidate = {
        x: offset.x + Math.min(...xs),
        y: offset.y + Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
      if (
        stamp !== epoch ||
        !current() ||
        candidate.width < 2 ||
        candidate.height < 2 ||
        !inside(candidate, pointer)
      )
        return;
      rect = candidate;
      const mode = await guest.debugger.sendCommand(
        'Runtime.callFunctionOn',
        {
          objectId: surfaceId,
          functionDeclaration: 'function(){return this.getAttribute("data-cindy-trackpad");}',
          returnByValue: true,
        },
        session,
      );
      if (stamp !== epoch || !current()) return;
      if (mode.result?.value === 'contacts') {
        // DOM event coordinates are relative to the element's own frame, not
        // its OOPIF target (which can itself contain same-origin frames).
        const bounds = await guest.debugger.sendCommand(
          'Runtime.callFunctionOn',
          {
            objectId: surfaceId,
            functionDeclaration:
              'function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y};}',
            returnByValue: true,
          },
          session,
        );
        if (stamp !== epoch || !current()) return;
        const local = bounds.result?.value;
        if (!local || !Number.isFinite(local.x) || !Number.isFinite(local.y)) return;
        surface = {
          objectId: surfaceId,
          session,
          offset: { x: candidate.x - local.x, y: candidate.y - local.y },
        };
      }
      capture = bridge.start(win.getNativeWindowHandle(), (text) => {
        if (stamp !== epoch) return;
        let packet: unknown;
        try {
          packet = JSON.parse(text);
        } catch {
          stop();
          return;
        }
        if (!isNativeTrackpadFrame(packet)) {
          stop();
          return;
        }
        send(packet, stamp);
      });
      log.debug('Native contact capture armed', { guestId: guest.id, capture });
    } catch {
      if (stamp === epoch) stop();
    } finally {
      for (const { objectId, session } of objects)
        if (objectId !== surface?.objectId && attached && !guest.isDestroyed())
          void guest.debugger
            .sendCommand('Runtime.releaseObject', { objectId }, session)
            .catch(() => {});
      locating = false;
    }
  };
  guest.on('dom-ready', () => {
    enabled = false;
    detach();
    // Opt-in belongs to the document, not the current focus/capture session.
    // Blur or history.replaceState while this read is pending must not leave
    // the same document permanently disabled.
    const stamp = ++documentEpoch;
    void guest
      .executeJavaScript(
        'document.querySelector("meta[name=cindy-native-trackpad]")?.content === "touch"',
      )
      .then((value) => {
        if (stamp === documentEpoch && !guest.isDestroyed()) {
          enabled = value === true;
          if (enabled) log.debug('Native contact document opted in', { guestId: guest.id });
        }
      })
      .catch(() => {});
  });
  guest.on('before-mouse-event', async (_event, input) => {
    if (!enabled || !current()) return;
    if (input.type === 'mouseDown') {
      void stop();
      return;
    }
    if (gesture) return;
    if (input.type === 'mouseLeave') {
      stop();
      return;
    }
    if (input.type !== 'mouseMove' && input.type !== 'mouseUp') return;
    const win = deps.window(host);
    if (!win) return;
    const native = deps.load();
    const p = native?.position ? native.position(win.getNativeWindowHandle()) : input;
    if (!p) return;
    const scale = guest.getZoomFactor();
    let origin = { x: 0, y: 0 };
    if (native?.position && host !== guest) {
      // AppKit reports window-content points. A sidebar webview has its own
      // viewport: subtract the exact embedding element before CDP hit testing.
      // Read only the trusted host; the plugin receives no new IPC capability.
      const read = ++pointerRead;
      try {
        const bounds = await host.executeJavaScript(`(() => {
          const view = [...document.querySelectorAll('webview')].find(v => {
            try { return v.getWebContentsId() === ${guest.id}; } catch { return false; }
          });
          if (!view) return null;
          const r = view.getBoundingClientRect();
          return {x:r.x, y:r.y, width:r.width, height:r.height};
        })()`);
        if (
          read !== pointerRead ||
          !current() ||
          !bounds ||
          ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
          bounds.width <= 0 ||
          bounds.height <= 0
        )
          return;
        const hostScale = host.getZoomFactor();
        origin = { x: bounds.x * hostScale, y: bounds.y * hostScale };
      } catch {
        return;
      }
    }
    pointer = { x: (p.x - origin.x) / scale, y: (p.y - origin.y) / scale };
    if (rect && !inside(rect, pointer)) stop();
    if (input.type === 'mouseMove' || input.type === 'mouseUp') void locate();
  });
  guest.debugger.on('message', (_e, method, params) => {
    if (!attached) return;
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe')
      frames.set(params.targetInfo.targetId, params.sessionId);
    if (method === 'Target.detachedFromTarget')
      for (const [id, session] of frames)
        if (session === params.sessionId) {
          frames.delete(id);
          stop();
        }
  });
  guest.debugger.on('detach', () => {
    attached = false;
    frames.clear();
    stop();
  });
  guest.on('blur', detach);
  guest.on('zoom-changed', detach);
  guest.on('did-start-navigation', (_e, _url, inPlace, main) => {
    if (main) {
      // A controller's history.replaceState does not get another dom-ready.
      // Drop the old binding, but keep the same document's explicit opt-in.
      if (inPlace) {
        void stop();
        return;
      }
      documentEpoch++;
      enabled = false;
      detach();
    }
  });
  guest.on('render-process-gone', () => {
    documentEpoch++;
    enabled = false;
    detach();
  });
  const win = deps.window(host);
  win?.on('resize', detach);
  win?.on('blur', detach);
  win?.on('hide', detach);
  guest.once('destroyed', () => {
    detach();
    host.removeListener('destroyed', detach);
    win?.removeListener('resize', detach);
    win?.removeListener('blur', detach);
    win?.removeListener('hide', detach);
  });
  host.once('destroyed', detach);
}
