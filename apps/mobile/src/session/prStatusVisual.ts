import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react-native';
import type { PrStatusKind } from '@cindy/maker-shared';
import type { ThemeColors } from '@/theme';

/**
 * PR 状态 → 图标 + 颜色。形状与颜色双编码,颜色只走语义 token(浅 / 深两套主题自动适配);
 * 状态未知(未加载 / 查询失败)时退回中性 GitPullRequest。后台任务卡与首页任务信息共用。
 */
export function prStatusVisual(
  kind: PrStatusKind | null,
  colors: ThemeColors,
): { Icon: LucideIcon; color: string } {
  switch (kind) {
    case 'merged':
      return { Icon: GitMerge, color: colors.textSecondary };
    case 'closed':
      return { Icon: GitPullRequestClosed, color: colors.statusError };
    case 'draft':
      return { Icon: GitPullRequestDraft, color: colors.textTertiary };
    case 'open':
      return { Icon: GitPullRequest, color: colors.statusDone };
    default:
      return { Icon: GitPullRequest, color: colors.textSecondary };
  }
}
