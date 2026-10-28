/**
 * dracoDecoder — 随应用打包的 Draco 解码器，转成 `blob:` URL 交给 3D SDK。
 * ---------------------------------------------------------------------------
 * `mivo-model-viewer` 默认从 gstatic CDN 取 Draco 解码器，打包应用必须离线可用，也
 * 不应依赖第三方 CDN。解码器随 `three` 一起发布（`examples/jsm/libs/draco/gltf/`）：
 *   - `draco_wasm_wrapper.js`（约 58KB）以 `?raw` 作为字符串打进包里；
 *   - `draco_decoder.wasm`（约 190KB）以 `?url` 引入，并由 `vite.renderer.config.ts` 的
 *     `assetsInlineLimit` 规则内联成 data URL。不能让它保留为独立资源文件：打包后的
 *     Renderer 以 `file://` 加载，页面不能 `fetch` 本地文件，pdfjs 那种 `/pdfjs/…` 同源
 *     路径在这里不适用。
 * 运行时再转成 `blob:` URL（CSP `connect-src` 已允许 `blob:`），通过 SDK 的
 * `setDracoDecoderFiles` 按文件名交给 DRACOLoader。开发模式下 `?url` 是 dev server 的
 * 同源路径，改用 `fetch` 取字节。
 *
 * 本模块体积约 300KB，只由 `modelViewerSdk` 动态 `import()`，不进主包。
 */

import wrapperSource from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?raw';
import wasmUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';

const DATA_URL_BASE64 = /^data:[^,]*;base64,/;

/** data URL 直接解码（不走 fetch：CSP connect-src 不含 data:）；其它 URL（dev server）用 fetch。 */
async function readAssetBytes(url: string): Promise<Uint8Array> {
  if (DATA_URL_BASE64.test(url)) {
    const binary = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to read the Draco decoder (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface DracoDecoderBlobUrls {
  'draco_wasm_wrapper.js': string;
  'draco_decoder.wasm': string;
}

let pending: Promise<DracoDecoderBlobUrls> | null = null;

/** 解码器文件的 blob URL（进程内只创建一次；失败后可重试）。 */
export function createDracoDecoderFiles(): Promise<DracoDecoderBlobUrls> {
  if (!pending) {
    pending = (async () => {
      const wasmBytes = await readAssetBytes(wasmUrl);
      return {
        'draco_wasm_wrapper.js': URL.createObjectURL(
          new Blob([wrapperSource], { type: 'text/javascript' }),
        ),
        'draco_decoder.wasm': URL.createObjectURL(
          new Blob([wasmBytes as BlobPart], { type: 'application/wasm' }),
        ),
      };
    })().catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}
