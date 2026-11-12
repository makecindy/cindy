import {
  DEFAULT_NEW_SESSION_DRAFT,
  type NewSessionDraft,
} from "@/session/newSession";
import type { RemoteSerializedAttachment } from "@/session/types";

export function newSessionDraft(
  patch: Partial<NewSessionDraft> = {},
): NewSessionDraft {
  return { ...DEFAULT_NEW_SESSION_DRAFT, ...patch };
}

export function newSessionAttachment(
  patch: Partial<RemoteSerializedAttachment> = {},
): RemoteSerializedAttachment {
  return {
    id: "photo",
    path: "oss://photo",
    name: "photo.png",
    ext: "png",
    size: 3,
    category: "image",
    mimeType: "image/png",
    ...patch,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
