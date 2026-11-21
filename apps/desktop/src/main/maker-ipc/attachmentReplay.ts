// Only the two main-process recovery owners can stamp a send. IPC and JSON
// cannot supply a symbol key, including on persisted user-controlled objects.
export const ACCEPTED_ATTACHMENT_REPLAY = Symbol('accepted attachment replay');
export function acceptedAttachmentReplay(options: unknown): typeof ACCEPTED_ATTACHMENT_REPLAY | undefined {
  return typeof options === 'object' && options !== null &&
    Reflect.get(options, ACCEPTED_ATTACHMENT_REPLAY) === true ? ACCEPTED_ATTACHMENT_REPLAY : undefined;
}
