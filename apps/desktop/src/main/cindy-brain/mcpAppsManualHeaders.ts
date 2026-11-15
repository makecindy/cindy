/**
 * mcpAppsManualHeaders.ts — cindy.fetch 自动带上《Cindy MCP Apps 页面生成手册》地址。
 * ---------------------------------------------------------------------------
 * 业务后端用 LLM 生成页面时，需要与员工客户端版本对应的那份手册。Host 不识别后端
 * 哪个接口在画页面，只按插件 mcpApps.ui 的声明判断：调用期间的工具对模型可见
 * （会打开页面卡片）时默认带上；插件可用 fetch 选项 mcpAppsManual 强制带或不带。
 * 地址只交给插件 network 已声明的主机（同凭证头），插件自带的同名头一律剥除。
 * 手册地址与 sha256 不是凭证，但仍不发往未声明主机，避免向任意站点暴露客户端版本。
 */

import { createHash } from 'node:crypto';

import { getPluginToolUi, pluginHasToolUi, pluginToolVisible } from '@cindy/plugin-protocol';

import { assertPluginPageManualVersion, pluginPageManualCdnPath } from '../../shared/pluginPageManual.mjs';
import type { InstalledGhost } from '../../shared/ghost.js';

export const MCP_APPS_MANUAL_HEADER = 'Cindy-MCP-Apps-Manual';
export const MCP_APPS_MANUAL_SHA256_HEADER = 'Cindy-MCP-Apps-Manual-Sha256';

export interface McpAppsManualRef {
  url: string;
  sha256: string;
}

/** 插件声明了有效的 mcpApps.ui；没声明的插件不必为手册头查在途调用。 */
export function pluginDeclaresMcpAppsUi(manifest: InstalledGhost['manifest']): boolean {
  return pluginHasToolUi(manifest);
}

/** 该工具在 mcpApps.ui.tools 中声明且对模型可见（即会打开页面卡片的工具）。 */
export function toolOpensMcpAppsPage(manifest: InstalledGhost['manifest'], tool: string | undefined): boolean {
  if (!tool || !getPluginToolUi(manifest)?.tools[tool]) return false;
  return pluginToolVisible(manifest, tool, 'model');
}

/**
 * 删掉插件自带的两个手册头（不区分大小写），再按需写入 Host 的值。
 * manual 为 null 表示本跳不带（未选中、版本无关、找不到手册或目标主机未声明）。
 */
export function applyMcpAppsManualHeaders(headers: Record<string, string>, manual: McpAppsManualRef | null): void {
  const names = new Set([MCP_APPS_MANUAL_HEADER.toLowerCase(), MCP_APPS_MANUAL_SHA256_HEADER.toLowerCase()]);
  for (const name of Object.keys(headers)) {
    if (names.has(name.toLowerCase())) delete headers[name];
  }
  if (!manual) return;
  headers[MCP_APPS_MANUAL_HEADER] = manual.url;
  headers[MCP_APPS_MANUAL_SHA256_HEADER] = manual.sha256;
}

/**
 * 内置手册引用：版本号与手册 sha256 首次需要时计算并缓存（安装期间二者不变）；
 * CDN 根地址每次现取，跟随端点清单更新。版本无关（0.0.0）、构建里没有手册或
 * 拿不到 CDN 根地址时返回 null，请求照常发出、不带手册头。读取手册时的意外错误
 * 不缓存，下次请求重试。
 */
export function createMcpAppsManualResolver(deps: {
  appVersion(): string;
  /** 构建里没有手册时返回 null；其它读取错误抛出。 */
  readManual(): Uint8Array | null;
  cdnBaseUrl(): string;
}): () => McpAppsManualRef | null {
  let manual: { path: string; sha256: string } | null | undefined;
  return () => {
    if (manual === undefined) {
      let version: string;
      try {
        version = deps.appVersion();
        assertPluginPageManualVersion(version);
      } catch {
        manual = null;
        return null;
      }
      let bytes: Uint8Array | null;
      try {
        bytes = deps.readManual();
      } catch {
        return null;
      }
      const sha256 = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
      manual = sha256 ? { path: pluginPageManualCdnPath(version, sha256), sha256 } : null;
    }
    if (!manual) return null;
    let base: string;
    try {
      base = deps.cdnBaseUrl().trim().replace(/\/+$/, '');
    } catch {
      return null;
    }
    return base ? { url: `${base}/${manual.path}`, sha256: manual.sha256 } : null;
  };
}
