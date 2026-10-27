import { useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button, HStack, Image, Rectangle, Text, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled,
  foregroundStyle,
  frame,
  listRowInsets,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { ComposerSheet } from './ComposerSheet';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { ComposerNativeRow } from './ComposerNativeRow';
import { TaskTagsPanel, type TaskTagsCompactState } from './TaskTags';
import { NativeTagSwatch, NativeTaskTagsExpanded } from './TaskTagsNative';
import { TAG_SWATCH, taskTagsPageTitle, useTaskTagsNativePage } from './taskTagsNativePage';
import { SessionActionSheet } from './SessionActionSheet';
import type { RemoteSession } from './types';
import { buildSessionActionMenu, type SessionSwipeAction } from './swipeRowRegistry';
import { useTheme, iconSize } from '@/theme';

type SessionOptionsProps = {
  session?: RemoteSession | null;
  onAction(action: SessionSwipeAction): void;
  onClose(): void;
  onClosed?(): void;
  pinnedAt: string | null | undefined;
  status?: string | null;
  visible: boolean;
};

export function SessionOptionsPresenter(props: SessionOptionsProps) {
  return Platform.OS === 'ios' ? (
    <SessionOptionsExpoSheet {...props} />
  ) : (
    <SessionActionSheet {...props} />
  );
}

const SWATCH_CELL = 44;

export function NativeTagShortcuts({ state }: { state: TaskTagsCompactState }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  // Even cells across the inset row; every cell keeps at least a 44pt target.
  const cells = Math.max(2, Math.min(8, Math.floor((width - 56) / SWATCH_CELL)));
  const count = Math.max(1, Math.min(7, cells - (state.canManage ? 1 : 0)));
  const shown = state.tags.slice(0, count);
  const filler = Math.max(0, cells - shown.length - (state.canManage ? 1 : 0));
  const cell = [frame({ maxWidth: Infinity, minHeight: 52 }), contentShape(shapes.rectangle())];
  return (
    <Section title={t('taskTags.title')}>
      {state.tags.length > 0 || state.canManage ? (
        <HStack
          spacing={0}
          modifiers={[listRowInsets({ leading: 8, trailing: 8, top: 2, bottom: 2 })]}
        >
          {shown.map((tag) => (
            <Button
              key={tag.id}
              onPress={() => state.onToggle(tag.id)}
              modifiers={[
                buttonStyle('plain'),
                frame({ maxWidth: Infinity }),
                disabled(state.disabled),
                accessibilityLabel(tag.name),
                accessibilityAddTraits(tag.selected ? ['isSelected'] : []),
              ]}
            >
              <ZStack modifiers={cell}>
                <NativeTagSwatch {...tag} size={TAG_SWATCH.picker} />
              </ZStack>
            </Button>
          ))}
          {state.canManage ? (
            <Button
              onPress={state.onManage}
              testID="home.sessionActions.tags.manage"
              modifiers={[
                buttonStyle('plain'),
                frame({ maxWidth: Infinity }),
                accessibilityLabel(t('taskTags.more')),
              ]}
            >
              <ZStack modifiers={cell}>
                <NativeTagSwatch
                  color={colors.surfaceChip}
                  checkColor={colors.textSecondary}
                  outlined={false}
                  selected={false}
                  size={TAG_SWATCH.picker}
                />
                <Image systemName="ellipsis" size={iconSize.sm} color={colors.textSecondary} />
              </ZStack>
            </Button>
          ) : null}
          {/* Keep cell widths stable when there are fewer tags than cells. */}
          {Array.from({ length: filler }, (_, index) => (
            <Rectangle
              key={`filler-${index}`}
              modifiers={[foregroundStyle('clear'), frame({ maxWidth: Infinity, minHeight: 52 })]}
            />
          ))}
        </HStack>
      ) : null}
      {state.message ? (
        <Text modifiers={[foregroundStyle(colors.textSecondary)]}>{state.message}</Text>
      ) : null}
      {state.canRetry ? (
        <ComposerNativeRow
          title={t('taskTags.retry')}
          onPress={state.onRetry}
          testID="home.sessionActions.tags.retry"
        />
      ) : null}
    </Section>
  );
}

function SessionOptionsExpoSheet({
  session,
  onAction,
  onClose,
  onClosed,
  pinnedAt,
  status,
  visible,
}: SessionOptionsProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const tagPage = useTaskTagsNativePage();
  useEffect(() => {
    if (!visible) setTagsExpanded(false);
  }, [visible]);
  const menu = buildSessionActionMenu(pinnedAt, status);
  const regular = menu.filter(
    (item) => !item.destructive && item.action !== 'archive' && item.action !== 'restore',
  );
  const destructive = menu.filter(
    (item) => item.destructive || item.action === 'archive' || item.action === 'restore',
  );
  const page = tagsExpanded ? (tagPage.page ?? 'list') : null;

  return (
    <ComposerSheet
      visible={visible}
      // The row the user swiped already names the task; only tag pages need a title.
      title={page ? taskTagsPageTitle(page, t) : ''}
      onBack={page ? tagPage.back : undefined}
      backDisabled={page ? tagPage.backDisabled : false}
      backLabel={t('taskTags.back')}
      onClose={onClose}
      onClosed={onClosed}
      nativeContent
      testID="home.sessionActions"
    >
      {!tagsExpanded ? (
        <Section>
          {regular.map((item) => (
            <ComposerNativeRow
              key={item.action}
              title={item.label}
              onPress={() => onAction(item.action)}
              testID={`home.sessionActions.${item.action}`}
            />
          ))}
        </Section>
      ) : null}
      {visible && session ? (
        <TaskTagsPanel
          key={`${session.canonicalDeviceId ?? session.deviceLinkDeviceId}:${session.id}`}
          session={session}
          expanded={tagsExpanded}
          onExpandedChange={setTagsExpanded}
          renderCompact={(state) => <NativeTagShortcuts state={state} />}
          renderExpanded={(state) => <NativeTaskTagsExpanded state={state} />}
          onPageChange={tagPage.onPageChange}
        />
      ) : null}
      {!tagsExpanded ? (
        <Section>
          {destructive.map((item) => (
            <Button
              key={item.action}
              role={item.destructive ? 'destructive' : undefined}
              onPress={() => onAction(item.action)}
              testID={`home.sessionActions.${item.action}`}
              modifiers={[buttonStyle('plain')]}
            >
              <Text
                modifiers={[
                  foregroundStyle(item.destructive ? colors.destructive : colors.textPrimary),
                  frame({
                    maxWidth: Infinity,
                    minHeight: 44,
                    alignment: 'leading',
                  }),
                  contentShape(shapes.rectangle()),
                ]}
              >
                {item.label}
              </Text>
            </Button>
          ))}
        </Section>
      ) : null}
    </ComposerSheet>
  );
}
