import { createHash } from 'node:crypto';
import { compressGzipSync, gunzipBase64TextBounded } from '@cindy/device-link/node-compression';
import type { DeviceLinkTransferCodec } from '@cindy/device-link';
import { createLogger } from '../logger';

const log = createLogger('device-link:compression');

/**
 * Desktop 既是被控端也是控制端（桌面远控桌面），两个方向共用一份编码器。
 * 保留 level 4 和同步发送错误契约；Node 编解码通过独立入口复用。
 */
export const desktopTransferCodec: DeviceLinkTransferCodec = {
  gzipBase64: (text) => {
    const { compressed, stats } = compressGzipSync(Buffer.from(text, 'utf8'), 4, true);
    log.debug('gzip candidate', stats);
    return compressed.toString('base64');
  },
  gunzipBase64: gunzipBase64TextBounded,
  contentTag: (text) => createHash('sha256').update(text).digest('base64url'),
};
