/**
 * Android WebView 不渲染 PDF(iOS 的 WKWebView 可以):安卓上 PDF 不进应用内
 * 预览,改由预览页的「导出 / 分享」交给系统 PDF 阅读器。平台由调用方传入
 * (Platform.OS),保持纯函数、可在 node 环境单测。
 */

import { remoteFilePreviewKind } from '@cindy/maker-shared/file-preview';

/** 此平台能否在应用内(WebView)预览 PDF。 */
export function pdfPreviewsInline(platformOs: string): boolean {
  return platformOs !== 'android';
}

/** 该文件在此平台上没有可用的应用内预览:长按菜单据此隐藏「快速预览」。 */
export function lacksInlinePreview(pathOrName: string, platformOs: string): boolean {
  return !pdfPreviewsInline(platformOs) && remoteFilePreviewKind(pathOrName) === 'pdf';
}
