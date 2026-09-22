import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Archive, UsersRound, RadioTower, Pencil } from 'lucide-react-native';
import { MobileVendorIcon } from '@/components/MobileVendorIcon';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, typeScale, lineHeight, fontWeight, iconSize, iconStroke } from '@/theme/tokens';
import type { RemoteSessionListItem } from './sessionList';
const HOME_SESSION_ROW_HEIGHT = 78;
const HOME_SESSION_SINGLE_LINE_ROW_HEIGHT = 60;
/** Shared by the full home list and its persistent, narrow task pane. */
export function SessionStatusMark({
  item,
  running,
  showDraftIndicator,
}: {
  item: RemoteSessionListItem;
  running: boolean;
  showDraftIndicator: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const archived = item.session.status === 'archived';
  const orcaLead = item.session.orcaRole === 'lead';
  const attached = readBooleanField(item.session, 'attached') || readBooleanField(item.session, 'deviceLinkAttached');
  // 用户拍板 2026-07-20(对齐桌面):running 一律 Thinking Orange(statusAccent)。
  const glyphColor = running ? colors.statusAccent : colors.textTertiary;
  return (
    <View style={styles.sessionStatusMark}>
      {archived ? (
        <Archive color={colors.textTertiary} size={iconSize.lg} strokeWidth={iconStroke.thin} />
      ) : orcaLead ? (
        // 与桌面 SessionStatusIcon /「+」菜单协同项同款 UsersRound，不再用旧 Puzzle。
        <SessionStatusPulse running={running}>
          <UsersRound color={glyphColor} size={iconSize.action} strokeWidth={iconStroke.thin} />
        </SessionStatusPulse>
      ) : attached ? (
        <SessionStatusPulse running={running}>
          <RadioTower color={glyphColor} size={iconSize.lg} strokeWidth={iconStroke.thin} />
        </SessionStatusPulse>
      ) : (
        <MobileVendorIcon
          color={glyphColor}
          running={running}
          // Claude 星标 logo 视觉重量偏小,+1px 光学补偿对齐 Codex 标(刻意非阶梯值)。
          size={isClaudeCodeAgentKind(item.session.agentKind) ? 19 : iconSize.lg}
          vendor={item.session.agentKind}
        />
      )}
      {!archived && showDraftIndicator ? (
        <View style={styles.sessionDraftIndicator}>
          {/* 9px:Pencil 微徽标,徽标容器几何依赖(designTokenDiscipline ALLOWLIST 登记豁免)。 */}
          <Pencil color={colors.textSecondary} size={9} strokeWidth={iconStroke.medium} />
        </View>
      ) : null}
    </View>
  );
}

function SessionStatusPulse({ children, running }: { children: ReactNode; running: boolean }) {
  const opacity = useRef(new Animated.Value(running ? 0.3 : 1)).current;
  useEffect(() => {
    opacity.stopAnimation();
    if (!running) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0.3);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 750,
          easing: Easing.inOut(Easing.ease),
          toValue: 0.3,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [opacity, running]);

  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}


function readBooleanField(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>)[key] === true;
}
function isClaudeCodeAgentKind(agentKind: string): boolean {
  return agentKind === 'cc' || agentKind === 'claude-code';
}

export const homeListStyles = (colors: ThemeColors) => StyleSheet.create({
  sessionListRow: {
    alignItems: 'stretch',
    backgroundColor: colors.surface,
    flexDirection: 'row',
    gap: spacing.md,
    height: HOME_SESSION_ROW_HEIGHT,
    paddingLeft: spacing.md,
  },
  sessionListRowSingleLine: {
    height: HOME_SESSION_SINGLE_LINE_ROW_HEIGHT,
  },
  sessionListRowIndented: {
    // 项目下属会话向右多缩进一档,让"隶属于该项目"在视觉上更明显
    // (连同行内分割线一起右移,形成嵌套层级感)。
    paddingLeft: spacing.md + spacing.lg,
  },
  sessionListRowDeepIndented: {
    // 自动化组子行:比 indented 再深一档(缩进全部收在行内,滑动包装全宽才能贴屏边),
    // 保证子行始终比组行(无论组行在 chats 还是项目组内)更深一层。
    paddingLeft: spacing.md + spacing.lg * 2,
  },
  sessionIconCell: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 22,
    width: 24,
  },
  sessionIconCellSingleLine: {
    justifyContent: 'center',
    paddingTop: 0,
  },
  sessionListContent: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
    paddingBottom: spacing.sm,
    paddingRight: spacing.lg,
    paddingTop: spacing.sm,
  },
  sessionListContentNoDivider: {
    // 紧邻块(项目组 / 自动化组)边界的行不画自己的缩进线:块的全宽 border 已经是这根线,
    // 两根 hairline 相邻会叠成一根明显更粗的线(即「项目组上边线偏粗」的根因)。
    borderBottomWidth: 0,
  },
  sessionTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    height: 30,
  },
  sessionStatusMark: {
    alignItems: 'center',
    height: 24,
    justifyContent: 'center',
    overflow: 'visible',
    position: 'relative',
    width: 24,
  },
  sessionDraftIndicator: {
    alignItems: 'center',
    bottom: -3,
    height: 12,
    justifyContent: 'center',
    position: 'absolute',
    right: -3,
    width: 12,
  },
  sessionTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.subtitle,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listTitle,
    minWidth: 0,
  },
  sessionPreviewRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    height: lineHeight.subtitle,
  },
  sessionPreview: {
    color: colors.textSecondary,
    flex: 1,
    fontSize: typeScale.code,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.subtitle,
    minWidth: 0,
  },
  sessionTrailingIcons: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    minHeight: lineHeight.subtitle,
    paddingTop: 3,
  },
  sessionTime: {
    color: colors.textTertiary,
    flexShrink: 0,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.body,
  },
  projectRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    flexDirection: 'row',
    gap: 8,
    minHeight: 56,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
  },
  projectLabel: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 6, // Desktop ProjectNode name / remote icon / machine label gap-1.5.
    minWidth: 0,
  },
  projectTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.listTitle,
    minWidth: 0,
  },
  projectFolderTitle: {
    flex: 0,
    flexShrink: 1,
  },
  projectCount: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.subtitle,
  },
});
const makeStyles = homeListStyles;
