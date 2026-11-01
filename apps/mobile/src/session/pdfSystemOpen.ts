/**
 * PDF.js 随客户端打包，iOS / Android / web 共用只读 PDF 预览。平台由调用方传入
 * (Platform.OS),保持纯函数、可在 node 环境单测。
 */

import { remoteFilePreviewKind } from '@cindy/maker-shared/file-preview';

/** 此平台能否在应用内(WebView)预览 PDF。 */
export function pdfPreviewsInline(platformOs: string): boolean {
  return (
    platformOs === "android" || platformOs === "ios" || platformOs === "web"
  );
}

/** 该文件在此平台上没有可用的应用内预览:长按菜单据此隐藏「快速预览」。 */
export function lacksInlinePreview(pathOrName: string, platformOs: string): boolean {
  return (
    !pdfPreviewsInline(platformOs) && remoteFilePreviewKind(pathOrName) === 'pdf'
  );
}
