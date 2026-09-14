/**
 * 搜索筛选面板。对照桌面 SearchFilterMenu:
 * 排序 / 状态 / 项目 / Agent / 最近活动。排序不计入红点。
 */
import { Check } from 'lucide-react-native';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { HomeGlassMenuPanel, HomeMenuScrim } from '@/session/HomeGlassMenuPanel';
import { useModalFadeLifecycle } from '@/session/useModalFadeLifecycle';
import {
  nextConversationSearchProjectSelection,
  type ConversationSearchProjectOption,
  type ConversationSearchProjectSelection,
} from '@/session/conversationSearch';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import type {
  ConversationSearchAgentFilter,
  ConversationSearchLastActivityFilter,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from '@cindy/maker-shared/conversation-search';

const SORT_OPTIONS: ConversationSearchSortBy[] = ['relevance', 'activityDesc', 'activityAsc'];
const STATUS_OPTIONS: ConversationSearchStatusFilter[] = ['active', 'archived', 'all'];
const AGENT_OPTIONS: ConversationSearchAgentFilter[] = ['all', 'cc', 'codex', 'pi'];
const LAST_ACTIVITY_OPTIONS: ConversationSearchLastActivityFilter[] = ['1d', '3d', '7d', '30d', 'all'];

export function ConversationSearchFilterSheet({
  activeCount,
  agentKind,
  lastActivity,
  lockedProjects,
  onAgentKindChange,
  onClose,
  onLastActivityChange,
  onProjectsChange,
  onReset,
  onSortChange,
  onStatusChange,
  projects,
  projectSelection,
  sortBy,
  status,
  topOffset,
  visible,
}: {
  activeCount: number;
  agentKind: ConversationSearchAgentFilter;
  lastActivity: ConversationSearchLastActivityFilter;
  lockedProjects: boolean;
  onAgentKindChange(value: ConversationSearchAgentFilter): void;
  onClose(): void;
  onLastActivityChange(value: ConversationSearchLastActivityFilter): void;
  onProjectsChange(value: ConversationSearchProjectSelection): void;
  onReset(): void;
  onSortChange(value: ConversationSearchSortBy): void;
  onStatusChange(value: ConversationSearchStatusFilter): void;
  projects: readonly ConversationSearchProjectOption[];
  projectSelection: ConversationSearchProjectSelection;
  sortBy: ConversationSearchSortBy;
  status: ConversationSearchStatusFilter;
  topOffset: number;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scrollMaxHeight = Math.max(200, screenHeight - topOffset - insets.bottom - 24);
  const { mounted, progress, onShowStartIn } = useModalFadeLifecycle(visible, {
    inMs: 140,
    outMs: 110,
  });
  const selectedProjects = projectSelection === 'all' ? null : new Set(projectSelection);
  const showProjectDevice = new Set(projects.map((project) => project.deviceId)).size > 1;

  return (
    <HomeMenuScrim
      backdropTestID="home.searchFilter.backdrop"
      onClose={onClose}
      onShow={onShowStartIn}
      progress={progress}
      topOffset={topOffset}
      visible={mounted}
    >
      <HomeGlassMenuPanel style={styles.panel} testID="home.searchFilter">
        <ScrollView style={[styles.scroll, { maxHeight: scrollMaxHeight }]} showsVerticalScrollIndicator>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{t('devices.list.search.filter.label')}</Text>
            {activeCount > 0 ? (
              <Pressable
                accessibilityLabel={t('devices.list.search.filter.reset')}
                accessibilityRole="button"
                hitSlop={6}
                onPress={onReset}
                style={({ pressed }) => [styles.resetButton, pressed && styles.pressed]}
                testID="home.searchFilter.reset"
              >
                <Text style={styles.resetText}>{t('devices.list.search.filter.reset')}</Text>
              </Pressable>
            ) : null}
          </View>

          <Text style={styles.sectionLabel}>{t('devices.list.search.filter.sortHeading')}</Text>
          {SORT_OPTIONS.map((value) => (
            <FilterMenuItem
              key={value}
              label={t(`devices.list.search.filter.sort.${value}`)}
              onPress={() => onSortChange(value)}
              selected={sortBy === value}
              testID={`home.searchFilter.sort.${value}`}
            />
          ))}

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>{t('devices.list.search.filter.statusHeading')}</Text>
          {STATUS_OPTIONS.map((value) => (
            <FilterMenuItem
              key={value}
              label={t(`devices.list.search.filter.status.${value}`)}
              onPress={() => onStatusChange(value)}
              selected={status === value}
              testID={`home.searchFilter.status.${value}`}
            />
          ))}

          {!lockedProjects && projects.length > 0 ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionLabel}>{t('devices.list.search.filter.projectsHeading')}</Text>
              <FilterMenuItem
                label={t('devices.list.search.filter.allProjects')}
                onPress={() => onProjectsChange('all')}
                selected={projectSelection === 'all'}
                testID="home.searchFilter.project.all"
              />
              {projects.map((project) => (
                <FilterMenuItem
                  key={project.key}
                  label={project.title}
                  meta={showProjectDevice && project.deviceName
                    ? `${project.deviceName} · ${project.count}`
                    : String(project.count)}
                  onPress={() => onProjectsChange(nextConversationSearchProjectSelection(projectSelection, project.key))}
                  selected={selectedProjects?.has(project.key) === true}
                  testID={`home.searchFilter.project.${sanitizeFilterTestId(project.key)}`}
                />
              ))}
            </>
          ) : null}

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>{t('devices.list.search.filter.agentHeading')}</Text>
          {AGENT_OPTIONS.map((value) => (
            <FilterMenuItem
              key={value}
              label={t(`devices.list.search.filter.agent.${value}`)}
              onPress={() => onAgentKindChange(value)}
              selected={agentKind === value}
              testID={`home.searchFilter.agent.${value}`}
            />
          ))}

          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>{t('devices.list.search.filter.lastActivityHeading')}</Text>
          {LAST_ACTIVITY_OPTIONS.map((value) => (
            <FilterMenuItem
              key={value}
              label={t(`devices.list.search.filter.lastActivity.${value}`)}
              onPress={() => onLastActivityChange(value)}
              selected={lastActivity === value}
              testID={`home.searchFilter.lastActivity.${value}`}
            />
          ))}
        </ScrollView>
      </HomeGlassMenuPanel>
    </HomeMenuScrim>
  );
}

function FilterMenuItem({
  label,
  meta,
  onPress,
  selected,
  testID,
}: {
  label: string;
  meta?: string;
  onPress(): void;
  selected: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.checkSlot}>
        {selected ? (
          <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.medium} />
        ) : null}
      </View>
      <Text numberOfLines={1} style={styles.itemText}>{label}</Text>
      {meta ? <Text style={styles.itemMeta}>{meta}</Text> : null}
    </Pressable>
  );
}

function sanitizeFilterTestId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  panel: {
    alignSelf: 'flex-end',
  },
  scroll: {
    flexGrow: 0,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
  },
  headerTitle: {
    color: colors.textTertiary,
    flex: 1,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  resetButton: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  resetText: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  sectionLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  item: {
    alignItems: 'center',
    borderRadius: radius.container,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  checkSlot: {
    alignItems: 'center',
    width: iconSize.md,
  },
  itemText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.body,
    minWidth: 0,
  },
  itemMeta: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
  },
  divider: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.sm,
    marginVertical: spacing.sm,
  },
  pressed: {
    opacity: 0.72,
  },
});
