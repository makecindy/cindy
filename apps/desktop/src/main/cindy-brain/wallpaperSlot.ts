import { MAX_WALLPAPER_IMAGE_BYTES } from '../../shared/appearanceSettings.js';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../shared/ghost.js';
import { extractIpcError } from '../../shared/ipcError.js';
import { throwIpcError } from '../utils/ipcValidate.js';

interface Deps {
  getGhost(id: string): InstalledGhost | null;
  scope(): string;
  readImage(id: string, url: string, assertCurrent: () => void): Promise<Buffer | null>;
  setImage(bytes: Buffer, assertCurrent: () => void): Promise<void>;
}

/** Local Desktop profile only. Only images already granted to this plugin can be applied. */
export class PluginWallpaperSlot {
  private busy = false;
  constructor(private readonly deps: Deps) {}

  async handle(id: string, raw: unknown): Promise<{ ok: boolean; errorCode?: string }> {
    const ghost = this.deps.getGhost(id);
    const authorized = (current: InstalledGhost | null) => current?.enabled === true &&
      current.approval.state === 'approved' && current.manifest.wallpaper === true &&
      current.wallpaperCapabilityApproved === true;
    if (!ghost || !authorized(ghost)) return { ok: false, errorCode: 'PERMISSION_DENIED' };
    if (this.busy) return { ok: false, errorCode: 'BUSY' };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { ok: false, errorCode: 'INVALID_PARAMS' };
    const url = (raw as Record<string, unknown>).mediaUrl;
    if (typeof url !== 'string' ||
      !/^cindy-media:\/\/blobs\/[a-f0-9]{64}\.(?:png|jpg|jpeg|webp)$/.test(url))
      return { ok: false, errorCode: 'INVALID_PARAMS' };
    const scope = this.deps.scope();
    const token = ghostInstallApprovalToken(ghost.approval);
    const assertCurrent = () => {
      const current = this.deps.getGhost(id);
      if (scope !== this.deps.scope() || !current || !authorized(current) ||
        ghostInstallApprovalToken(current.approval) !== token)
        throwIpcError('PERMISSION_DENIED', 'Wallpaper permission changed');
    };
    this.busy = true;
    try {
      assertCurrent();
      const bytes = await this.deps.readImage(id, url, assertCurrent);
      assertCurrent();
      if (!bytes) return { ok: false, errorCode: 'PERMISSION_DENIED' };
      if (!bytes.length || bytes.length > MAX_WALLPAPER_IMAGE_BYTES)
        return { ok: false, errorCode: 'INVALID_PARAMS' };
      await this.deps.setImage(bytes, assertCurrent);
      return { ok: true };
    } catch (error) {
      const code = extractIpcError(error)?.code;
      return { ok: false, errorCode: code === 'INVALID_PARAMS' || code === 'PERMISSION_DENIED' ? code : 'INTERNAL' };
    } finally {
      this.busy = false;
    }
  }
}
