/**
 * 代输入 scan-to-sign-in on the phone: the QR code on the computer arrives
 * inside the sealed per-step offer (like a screenshot step), and lives only in
 * this hook's state for one revision. A tap on it goes back on the same
 * exchange and taps the code in the window (for example to refresh an expired one).
 */
import { useEffect, useRef, useState } from "react";
import {
  inputHandoffQrLink,
  type InputHandoffPicture,
  type InputHandoffQrLink,
  type InputHandoffSnapshot,
  type InputHandoffSubmission,
} from "@cindy/device-link";

export type InputHandoffQrState = "idle" | "loading" | "shown" | "sending" | "failed";

export interface InputHandoffQrView {
  state: InputHandoffQrState;
  picture: InputHandoffPicture | null;
  /** The code's content as a link to open here (web or app link); null when it is not one. */
  link: InputHandoffQrLink | null;
  /** The code's content, for copying. */
  text: string | null;
  load(): void;
  /** Taps the code in the window, at fractions of the picture. */
  tap(x: number, y: number): void;
}

type OpenPicture = (
  snapshot: InputHandoffSnapshot,
  answer: (picture: InputHandoffPicture) => Promise<InputHandoffSubmission>,
) => Promise<void>;

export function useInputHandoffQr({
  snapshot,
  active,
  openPicture,
  onError,
}: {
  snapshot: InputHandoffSnapshot;
  /** The sheet is open on a code that is on screen. */
  active: boolean;
  openPicture: OpenPicture;
  onError(message: "stale" | "submit" | null): void;
}): InputHandoffQrView {
  const [state, setState] = useState<InputHandoffQrState>("idle");
  const [picture, setPicture] = useState<InputHandoffPicture | null>(null);
  const pending = useRef<{ resolve(submission: InputHandoffSubmission): void; reject(error: Error): void } | null>(null);
  const generation = useRef(0);
  const scan = snapshot.qr === "scan" && snapshot.picture === true && !snapshot.terminal;
  const key = `${snapshot.requestId}:${snapshot.revision}`;
  const revision = useRef(snapshot.revision);
  revision.current = snapshot.revision;

  const drop = () => {
    generation.current++;
    pending.current?.reject(new Error("INPUT_HANDOFF_CLOSED"));
    pending.current = null;
    setPicture(null);
  };

  const load = () => {
    if (!scan || snapshot.remoteInput !== true) return;
    drop();
    const mine = generation.current;
    let answered = false;
    setState("loading");
    onError(null);
    openPicture(snapshot, (next) =>
      new Promise<InputHandoffSubmission>((resolve, reject) => {
        if (generation.current !== mine) {
          reject(new Error("INPUT_HANDOFF_CLOSED"));
          return;
        }
        pending.current = {
          resolve: (submission) => {
            answered = true;
            resolve(submission);
          },
          reject,
        };
        setPicture(next.qr ? next : null);
        setState(next.qr ? "shown" : "failed");
      }),
    )
      .then(() => {
        if (generation.current === mine) setState("sending");
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        pending.current = null;
        setPicture(null);
        if (answered) onError(e instanceof Error && e.message === "INPUT_HANDOFF_STALE" ? "stale" : "submit");
        setState(answered ? "idle" : "failed");
      });
  };

  // One code per revision: a refreshed code is a new revision and loads by itself while the sheet is open.
  useEffect(() => {
    if (active && scan) load();
    else {
      drop();
      setState("idle");
    }
    return drop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads per revision and when the sheet opens
  }, [key, active, scan]);

  const tap = (x: number, y: number) => {
    const reply = pending.current;
    // An agent's screenshot is not a window: there is nothing on screen to tap.
    if (!reply || state !== "shown" || snapshot.agentPicture) return;
    pending.current = null;
    setState("sending");
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    reply.resolve({ expectedRevision: revision.current, values: {}, action: { kind: "tap", x: clamp(x), y: clamp(y) } });
  };

  const qr = picture?.qr ?? null;
  return {
    state,
    picture,
    link: qr ? inputHandoffQrLink(qr) : null,
    text: qr?.text ?? null,
    load,
    tap,
  };
}
