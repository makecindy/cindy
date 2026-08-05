/**
 * remoteMediaDiskCacheExpo.ts — remoteMediaDiskCache 的 expo-file-system IO 适配。
 * ---------------------------------------------------------------------------
 * 目录固定在系统 cache 区(Paths.cache/remote-media):OS 低存储可整体回收,
 * 回收后当冷缓存重新取件即可(纯模块的 lookup 自愈已处理文件丢失)。
 * expo-file-system 的原生模块随 expo 核心包已链接进现有原生构建,本文件只是
 * JS 层引用,不影响 fingerprint(以 mobile:release:check 实测为准)。
 */
import { Directory, File, Paths } from 'expo-file-system';

import { extOfMime, type RemoteMediaDiskCacheIO } from '@/session/remoteMediaDiskCache';

const CACHE_DIR_NAME = 'remote-media';
const INDEX_FILE_NAME = 'index.json';
const INDEX_TMP_NAME = 'index.json.tmp';
const SHARE_TMP_DIR_NAME = 'remote-media-share';

/**
 * 一次性分享临时文件:超出磁盘缓存预算的对象走 store 会被 LRU 立即逐出,
 * lookup 拿不到 → 分享失败。这里绕开 LRU 直接下到独立临时目录,只服务本次
 * 分享;文件留在系统 cache 区,OS 低存储时统一回收(罕见路径,不做主动清理)。
 */
export async function downloadRemoteMediaShareTemp(
  url: string,
  mimeType: string,
  fileName?: string,
): Promise<string | null> {
  try {
    const dir = new Directory(Paths.cache, SHARE_TMP_DIR_NAME);
    dir.create({ intermediates: true, idempotent: true });
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // 带原始文件名时落进一次性唯一子目录:分享单里显示真实文件名与扩展名
    // (PDF/视频/压缩包等非图片类型靠扩展名保住类型识别,extOfMime 只认图片
    // mime,兜底 .img 会让接收方无法正确预览);子目录唯一化避免同名冲突。
    const safeName = fileName?.replace(/[\\/:*?"<>|]/g, '_').trim();
    let target: File;
    if (safeName) {
      const sub = new Directory(dir, unique);
      sub.create({ intermediates: true, idempotent: true });
      target = new File(sub, safeName);
    } else {
      target = new File(dir, `share-${unique}.${extOfMime(mimeType)}`);
    }
    const file = await File.downloadFileAsync(url, target, { idempotent: true });
    return (file.size ?? 0) > 0 ? file.uri : null;
  } catch {
    return null; // 分享失败由调用方兜底提示
  }
}

/**
 * 下载 → 读成 `data:` URI → 删临时文件。
 *
 * 给 HTML 渲染态的同目录资源用:**预签名地址只在 app 侧使用,绝不写进页面**。
 * 写进页面等于把一个 bearer 凭证交给可执行的不可信文档 —— 内联脚本能读 `img.src`
 * 再以 no-cors 外传,第三方就能在有效期内下载被控端文件(review P1 实捉)。
 *
 * 超过 maxBytes 返回 null(调用方保留原引用,渲染成破图):data URI 会整份进 JS 字符串
 * 与 DOM,不设上限会被一张大图撑爆内存。
 */
export async function downloadRemoteMediaAsDataUri(
  url: string,
  mimeType: string,
  maxBytes: number,
): Promise<string | null> {
  const dir = new Directory(Paths.cache, SHARE_TMP_DIR_NAME);
  let target: File | null = null;
  try {
    dir.create({ intermediates: true, idempotent: true });
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    target = new File(dir, `res-${unique}.${extOfMime(mimeType)}`);
    const file = await File.downloadFileAsync(url, target, { idempotent: true });
    const size = file.size ?? 0;
    if (size <= 0 || size > maxBytes) return null;
    const base64 = await file.base64();
    return base64 ? `data:${mimeType};base64,${base64}` : null;
  } catch {
    return null;
  } finally {
    // 临时文件用完即删:资源可能几十个,留着会把 cache 目录堆满。
    try {
      target?.delete();
    } catch {
      // 删不掉不影响结果(系统会回收 cache 目录)。
    }
  }
}

export function createExpoRemoteMediaDiskCacheIO(): RemoteMediaDiskCacheIO {
  const dir = new Directory(Paths.cache, CACHE_DIR_NAME);
  return {
    ensureDir() {
      dir.create({ intermediates: true, idempotent: true });
    },
    async readIndexText() {
      const file = new File(dir, INDEX_FILE_NAME);
      if (!file.exists) return null;
      return file.text();
    },
    writeIndexText(text) {
      // 原子写:先写临时文件,再 overwrite move 顶替正式 index——覆盖写中途
      // App 被杀不会留下截断 JSON(损坏索引会让全部落盘文件变成不可回收孤儿)。
      const tmp = new File(dir, INDEX_TMP_NAME);
      tmp.write(text);
      tmp.moveSync(new File(dir, INDEX_FILE_NAME), { overwrite: true });
    },
    fileExists(name) {
      return new File(dir, name).exists;
    },
    fileUri(name) {
      return new File(dir, name).uri;
    },
    deleteFile(name) {
      const file = new File(dir, name);
      if (file.exists) file.delete();
    },
    async writeFileBase64(name, base64) {
      // 契约同 download:先写临时名,成功后原子顶替,失败不动既有同名好文件。
      // base64 → 字节交给 legacy writeAsStringAsync 原生解码(新 API File.write
      // 只收 string/Uint8Array,JS 侧手动 atob 解大图纯浪费);残留 .wb.tmp 由
      // init 对账当孤儿清掉。
      const tmp = new File(dir, `${name}.wb.tmp`);
      try {
        const FileSystem = await import('expo-file-system/legacy');
        await FileSystem.writeAsStringAsync(tmp.uri, base64, { encoding: FileSystem.EncodingType.Base64 });
        const size = tmp.size ?? 0;
        if (size <= 0) {
          if (tmp.exists) tmp.delete();
          return null;
        }
        tmp.moveSync(new File(dir, name), { overwrite: true });
        return size;
      } catch {
        try {
          if (tmp.exists) tmp.delete();
        } catch {
          // best-effort:残留临时文件由 init 对账兜底
        }
        return null; // 缓存是纯优化,写入失败静默(渲染回退 data URI)
      }
    },
    async download(url, name) {
      // 契约(RemoteMediaDiskCacheIO.download):失败不得破坏既有同名好文件。
      // downloadFileAsync 直接写目标(Android 失败可留半成品),所以先下到临时名,
      // 正尺寸成功后原子顶替;失败 / 空文件清临时、不动现有文件(返回 null,上层
      // 保留旧条目继续离线可看)。残留的 .dl.tmp 由 init 对账当孤儿清掉。
      const tmp = new File(dir, `${name}.dl.tmp`);
      try {
        const downloaded = await File.downloadFileAsync(url, tmp, { idempotent: true });
        const size = downloaded.size ?? 0;
        if (size <= 0) {
          if (tmp.exists) tmp.delete();
          return null;
        }
        tmp.moveSync(new File(dir, name), { overwrite: true });
        return size;
      } catch {
        try {
          if (tmp.exists) tmp.delete();
        } catch {
          // best-effort:残留临时文件由 init 对账兜底
        }
        return null; // 缓存是纯优化,下载失败静默(下次取件再试)
      }
    },
    listFiles() {
      // 数据文件名列表(契约:不含 index 自身与临时文件),供 init 对账删孤儿。
      // .dl.tmp 残留刻意**不**过滤——它们不在 index 里,正该被对账清掉。
      return dir.list()
        .filter((item): item is File => item instanceof File)
        .map((file) => file.name)
        .filter((name) => name !== INDEX_FILE_NAME && name !== INDEX_TMP_NAME);
    },
  };
}
