import matter from 'gray-matter';
import type { GhostSkillItem } from '../shared/ghost.js';
import { parseAndValidateFrontmatter } from './frontmatterValidation.js';

export function checkSkillMdConsistency(content: string, item: GhostSkillItem): string | null {
  let data: Record<string, unknown>;
  try {
    data = (matter(content).data as Record<string, unknown>) ?? {};
  } catch {
    return 'SKILL.md frontmatter 无法解析(YAML 语法错误)';
  }
  const { issues } = parseAndValidateFrontmatter(content, 'skill');
  if (issues.length > 0) {
    return `SKILL.md frontmatter 不合格:${issues.map((i) => `${i.field}:${i.message}`).join('; ')}`;
  }
  const fmName = typeof data.name === 'string' ? data.name.trim() : '';
  const fmDescription = typeof data.description === 'string' ? data.description.trim() : '';
  if (fmName !== item.name) {
    return `SKILL.md frontmatter name ${JSON.stringify(fmName)} 与清单声明 ${JSON.stringify(item.name)} 不一致(插件详情展示的必须就是 Agent 读到的)`;
  }
  if (fmDescription !== item.description) {
    return 'SKILL.md frontmatter description 与清单声明不一致(插件详情展示的必须就是 Agent 读到的)';
  }
  return null;
}

