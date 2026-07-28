import type { ImageVisibleBounds } from './imageVisibleBounds';

export const LOCAL_THEME_SUFFIX = '-local';

export function isLocalThemeId(id: string): boolean {
  return id.endsWith(LOCAL_THEME_SUFFIX);
}

export interface LocalThemeBrandConfig {
  /** 新建对话页左侧方形图标的本地图片绝对路径。 */
  icon?: string;
  /** 新建对话页右侧横向 logo 的本地图片绝对路径。 */
  logo?: string;
}

export interface LocalThemeBrandBounds {
  icon?: ImageVisibleBounds;
  logo?: ImageVisibleBounds;
}

export interface LocalThemeBrandRevisions {
  icon?: string;
  logo?: string;
}

export interface LocalThemeWire {
  id: string;
  name: string;
  type: 'light' | 'dark';
  /**
   * 可选的家族键：同一 family 下的 light + dark 两个本地主题会在设置里合并成
   * 一个可跟随模式切换的主题（外部主题导入的双态产物、用户手写的一对主题都用
   * 它配对）。缺省时每个文件各自成家族——老本地主题的行为因此逐字不变。
   */
  family?: string;
  colors: Record<string, string>;
  /** 新版品牌区配置；renderer 装载时把路径转成 xdt-file:// URL。 */
  brand?: LocalThemeBrandConfig;
  /** loader 从透明像素计算出的运行时裁边信息，不写回用户 JSON。 */
  brandBounds?: LocalThemeBrandBounds;
  /** loader 从文件状态生成的运行时版本号，用于刷新同一路径下被替换的图片。 */
  brandRevisions?: LocalThemeBrandRevisions;
}

export interface LocalThemeDiagnostic {
  file: string;
  error: string;
}

export interface LocalThemesPayload {
  success: true;
  themes: LocalThemeWire[];
  diagnostics: LocalThemeDiagnostic[];
}

export interface LocalThemesErrorPayload {
  success: false;
  error: string;
  themes: [];
  diagnostics: [];
}

export type LocalThemesResult = LocalThemesPayload | LocalThemesErrorPayload;

export interface LocalThemeWriteRequest {
  baseId: string;
  theme: {
    id: string;
    name: string;
    type: 'light' | 'dark';
    /** 见 LocalThemeWire.family；导入的双态产物用它配对。 */
    family?: string;
    /**
     * 品牌素材本地绝对路径；空串表示使用默认素材。「复制主题」会写入示例路径
     * 教用户怎么配；外部主题导入不带品牌素材，此项缺省。
     */
    brand?: {
      icon: string;
      logo: string;
    };
    colors: Record<string, string>;
  };
}

export type LocalThemeWriteResult =
  | { success: true; path: string; finalId: string }
  | { success: false; error: string };

export type LocalThemeOpenDirResult =
  | { success: true; path: string }
  | { success: false; error: string };
