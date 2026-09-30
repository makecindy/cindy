import type { DesktopIceServer } from '@cindy/device-link';
export const FILE_PEER_LOCAL = {
  REGISTER: 'file-peer:host:register',
  COMMAND: 'file-peer:host:command',
  REPLY: 'file-peer:host:reply',
  READ: 'file-peer:host:read',
  WRITE: 'file-peer:host:write',
  INVOKE: 'file-peer:host:invoke',
} as const;
export type FilePeerCommand =
  | { action: 'offer'; connection: string; servers: DesktopIceServer[]; streaming?: boolean }
  | { action: 'stats'; connection: string }
  | { action: 'invoke'; connection: string; payload: string }
  | { action: 'accept'; connection: string; servers: DesktopIceServer[]; sdp: string }
  | { action: 'answer'; connection: string; sdp: string }
  | { action: 'receive'; connection: string; ticket: string; size: number; sink: string }
  | { action: 'close'; connection: string };
export interface FilePeerHostApi {
  register(): Promise<void>;
  onCommand(fn: (id: string, command: FilePeerCommand) => void): () => void;
  reply(id: string, ok: boolean, value?: string): Promise<void>;
  read(connection: string, ticket: string, offset: number): Promise<string>;
  write(sink: string, offset: number, base64: string): Promise<void>;
  invoke(connection: string, payload: string): Promise<string>;
}
