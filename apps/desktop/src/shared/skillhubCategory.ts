/**
 * SkillHub 分类（main / preload / renderer 共享类型）。
 * slug 是后端稳定标识，name 是展示用本地化字符串。
 * count = 当前目录中该分类下可见的 skill 数（Hub skillCount）。
 * myCount = 同一目录中当前用户发布的 skill 数（Hub mySkillCount）。
 */
export interface MarketCategory {
  slug: string;
  name: string;
  count: number;
  myCount: number;
  source?: 'platform';
  children?: MarketCategory[];
}

export const CATEGORY_ALL = 'all' as const;
