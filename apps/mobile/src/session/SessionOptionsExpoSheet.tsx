import { useEffect, useState } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { SessionDetailsNativeHeading } from './SessionDetailsNative';
import { Button, Group, HStack, Image, RNHostView, Text, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled,
  foregroundStyle,
  onGeometryChange,
  frame,
  listRowInsets,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { ComposerSheet } from './ComposerSheet';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { ComposerNativeRow } from './ComposerNativeRow';
import { TaskMenuHeading, TaskTagsPanel, type TaskTagsCompactState } from './TaskTags';
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

export function NativeTagShortcuts({ state }: { state: TaskTagsCompactState }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  // Reserve room for management, without shrinking the 44pt tap targets.
  const count = Math.max(1, Math.min(7, Math.floor((width - 80) / 44) - 1));
  return (
    <Section title={t('taskTags.title')}>
      {state.tags.length > 0 || state.canManage ? (
        <HStack
          spacing={0}
          modifiers={[listRowInsets({ leading: 8, trailing: 8, top: 4, bottom: 4 })]}
        >
          {state.tags.slice(0, count).map((tag) => (
            <Button
              key={tag.id}
              onPress={() => state.onToggle(tag.id)}
              modifiers={[
                buttonStyle('plain'),
                disabled(state.disabled),
                accessibilityLabel(tag.name),
                accessibilityAddTraits(tag.selected ? ['isSelected'] : []),
              ]}
            >
              <ZStack
                modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]}
              >
                <Image systemName="circle.fill" size={iconSize.action} color={tag.color} />
                <Image systemName="circle" size={iconSize.action} color={colors.border} />
                {tag.selected ? (
                  <Image systemName="checkmark" size={iconSize.xs} color={tag.checkColor} />
                ) : null}
              </ZStack>
            </Button>
          ))}
          {state.canManage ? (
            <Button
              onPress={state.onManage}
              modifiers={[
                buttonStyle('plain'),
                accessibilityLabel(t('taskTags.title')),
              ]}
            >
              <ZStack
                modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]}
              >
                <Image systemName="circle" size={iconSize.action} color={colors.border} />
                <Image systemName="ellipsis" size={iconSize.xs} color={colors.textSecondary} />
              </ZStack>
            </Button>
          ) : null}
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
  const { width } = useWindowDimensions();
  const [headingWidth, setHeadingWidth] = useState<number | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
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

  return (
    <ComposerSheet
      visible={visible}
      title=""
      nativeHeader={
        session ? (
          <>
            <SessionDetailsNativeHeading
              title={projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle'))}
              backLabel={t('taskTags.back')}
            />
            <Group
              modifiers={[
                frame({ maxWidth: Infinity }),
                onGeometryChange(({ width: measured }) => {
                  if (measured > 0) setHeadingWidth(measured);
                }),
              ]}
            >
              <RNHostView matchContents>
                <View style={{ width: headingWidth ?? width }}>
                  <TaskMenuHeading session={session} showTitle={false} />
                </View>
              </RNHostView>
            </Group>
          </>
        ) : undefined
      }
      onClose={onClose}
      onClosed={onClosed}
      nativeContent={!tagsExpanded}
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
