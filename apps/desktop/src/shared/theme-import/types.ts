/** 外部主题导入的跨进程协议类型（main 转换 → renderer 展示报告）。 */

import type { ThemeTypeName } from './palette';

export type ThemeImportSource = 'vscode' | 'obsidian';

/** 一次转换产出的单个主题（Obsidian 双态 CSS 会产出两个）。 */
export interface ConvertedTheme {
  /** 展示名，取自源文件的 name / manifest / 文件名。 */
  name: string;
  type: ThemeTypeName;
  /** 已过滤豁免族的 Cindy token map。 */
  colors: Record<string, string>;
}

/** 转换报告——如实告诉用户哪些东西没跟过来。 */
export interface ThemeConversionReport {
  source: ThemeImportSource;
  /** 直接从源文件读到的色板角色数（13 个角色里命中几个）。 */
  resolvedRoles: number;
  /** 源文件没提供、由我们从已知色推导出来的角色名。 */
  derivedRoles: string[];
  /** 源文件里出现但无法静态求值的项（`color-mix()`、未定义的 var() 等）。 */
  unresolved: string[];
  /** 被语义豁免族拦下的 token 数。 */
  skippedProtected: number;
}

export interface ThemeConversionResult {
  themes: ConvertedTheme[];
  report: ThemeConversionReport;
}

/** 落盘后的单个产物（跨 IPC 返回给 renderer 的部分不含绝对路径）。 */
export interface ImportedThemeFile {
  /** 盘上文件名去掉扩展名后的 id（未含 `-local` 后缀）。 */
  id: string;
  name: string;
  type: ThemeTypeName;
}

/** main 内部用：带文件路径，用于回滚。不跨 IPC。 */
export interface ImportedThemeFileInternal extends ImportedThemeFile {
  path: string;
}

export type LocalThemeImportResult =
  | {
      /** 用户在原生对话框里取消。 */
      canceled: true;
    }
  | {
      canceled: false;
      written: ImportedThemeFile[];
      report: ThemeConversionReport;
    };
