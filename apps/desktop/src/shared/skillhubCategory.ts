/**
 * SkillHub 分类（main / preload / renderer 共享类型）。
 * slug 是后端稳定标识，name 是展示用本地化字符串。
 * count = 该分类下总 skill 数（Hub skillCount）。
 * myCount = 该分类下当前用户发布的 skill 数（Hub mySkillCount）。
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
