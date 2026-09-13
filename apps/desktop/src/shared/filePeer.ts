import type { DesktopIceServer } from '@cindy/device-link';
export const FILE_PEER_LOCAL = {
  REGISTER: 'file-peer:host:register',
  COMMAND: 'file-peer:host:command',
  REPLY: 'file-peer:host:reply',
  READ: 'file-peer:host:read',
  WRITE: 'file-peer:host:write',
} as const;
export type FilePeerCommand =
  | { action: 'offer'; connection: string; servers: DesktopIceServer[] }
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
}
