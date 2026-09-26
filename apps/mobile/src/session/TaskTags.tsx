import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react';
import {
  Pressable,
  useWindowDimensions,
  ScrollView,
  View,
  type TextInput as NativeTextInput,
} from 'react-native';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import Animated, {
  runOnJS,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  cancelAnimation,
  ReduceMotion,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { GripVertical, Pencil, MoreHorizontal, ArrowLeft } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  TASK_TAG_COLORS,
  taskTagNameKey,
  taskTagErrorKey,
  taskTagEditRevision,
  normalizeTaskTags,
  reconcileTaskTags,
  type TaskTag,
  type TaskTagColor,
  type TaskTagRequest,
  type TaskTagResult,
} from '@cindy/maker-shared';
import { Text, TextInput } from '@/components/AppText';
import { useDeviceLink, subscribeRemoteTaskTagsChanged } from '@/device-link/DeviceLinkContext';
import { useTheme, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale, iconSize, fontWeight, lineHeight, motionDuration, motionEasing } from '@/theme/tokens';
import { remoteSessionStore, useRemoteSessions } from './remoteSessionStore';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { useAuth } from '@/auth/AuthContext';
import {
  readTaskTagCatalog,
  writeTaskTagCatalog,
  taskTagCacheGeneration,
  sameTaskTags,
} from './taskTagCatalogCache';
import type { RemoteSession } from './types';

function colorFor(tag: TaskTag, colors: ThemeColors) {
  const palette = {
    red: colors.taskTagRed,
    orange: colors.taskTagOrange,
    yellow: colors.taskTagYellow,
    green: colors.taskTagGreen,
    blue: colors.taskTagBlue,
    purple: colors.taskTagPurple,
    gray: colors.taskTagGray,
    none: colors.taskTagWhite,
    pink: colors.taskTagPink,
    coral: colors.taskTagCoral,
    teal: colors.taskTagTeal,
    indigo: colors.taskTagIndigo,
    white: colors.taskTagWhite,
  };
  return palette[tag.color];
}
function tagName(tag: TaskTag, t: (key: string) => string) {
  const key = taskTagNameKey(tag);
  return key ? t(key) : tag.name;
}
export function TaskTagDots({
  tags = [],
  surfaceColor,
  maxVisible,
  onPress,
}: {
  tags?: TaskTag[];
  surfaceColor?: string;
  maxVisible?: number;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (!tags.length) return null;
  const label = `${t('taskTags.title')}: ${tags.map((tag) => tagName(tag, t)).join(', ')}`;
  const dots = (
    <View
      pointerEvents="none"
      style={{
        flexDirection: 'row',
        paddingLeft: spacing.xs,
        flexShrink: 0,
        minHeight: 24,
        alignItems: 'center',
      }}
    >
      {tags.slice(0, maxVisible).map((tag) => (
        <View
          key={tag.id}
          style={{
            width: 10,
            height: 10,
            marginLeft: -4,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor:
              tag.color === 'none' || tag.color === 'white'
                ? colors.border
                : (surfaceColor ?? colors.surface),
            backgroundColor: colorFor(tag, colors),
          }}
        />
      ))}
    </View>
  );
  // List dots are display-only; touches and long presses belong to the task row.
  // Header dots can explicitly open task details, without a separate popover.
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={{ flexShrink: 0 }}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
    >
      {dots}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      pointerEvents="none"
      style={{ flexShrink: 0 }}
    >
      {dots}
    </View>
  );
}
/** Read-only labels beside the title; selection remains in the task menu. */
export function TaskTagLabels({ tags = [] }: { tags?: TaskTag[] }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <>
      {tags.map((tag) => (
        <View
          key={tag.id}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.xs,
            maxWidth: '100%',
            paddingHorizontal: spacing.xs,
            paddingVertical: 2,
            borderRadius: radius.control,
            backgroundColor: colors.surfaceChip,
          }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              flexShrink: 0,
              borderRadius: radius.pill,
              backgroundColor: colorFor(tag, colors),
              borderWidth: 1,
              borderColor: colors.border,
            }}
          />
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: typeScale.caption,
              lineHeight: lineHeight.caption,
              flexShrink: 1,
            }}
          >
            {tagName(tag, t)}
          </Text>
        </View>
      ))}
    </>
  );
}
export function TaskMenuHeading({
  session,
  showTitle = true,
}: {
  session: RemoteSession;
  showTitle?: boolean;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const sessions = useRemoteSessions();
  const current =
    sessions.find(
      (item) =>
        item.id === session.id &&
        (item.canonicalDeviceId ?? item.deviceLinkDeviceId) ===
          (session.canonicalDeviceId ?? session.deviceLinkDeviceId),
    ) ?? session;
  return (
    <View
      style={{
        paddingHorizontal: spacing.lg,
        paddingTop: showTitle ? spacing.xxl : spacing.xs,
        paddingBottom: spacing.xs,
        gap: spacing.sm,
      }}
    >
      {showTitle && (
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          style={{
            textAlign: 'center',
            color: colors.textPrimary,
            fontSize: typeScale.body,
            lineHeight: lineHeight.body,
            fontWeight: fontWeight.semibold,
          }}
        >
          {projectDraftSessionTitle(current.title, t('session.menu.unnamedTitle'))}
        </Text>
      )}
      {!!current.tags?.length && (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'center',
            alignItems: 'center',
            gap: spacing.xs,
          }}
        >
          <TaskTagLabels tags={current.tags} />
        </View>
      )}
    </View>
  );
}

export interface TaskTagsCompactState {
  tags: {
    id: string;
    name: string;
    color: string;
    checkColor: string;
    selected: boolean;
  }[];
  disabled: boolean;
  message?: string;
  canRetry: boolean;
  canManage: boolean;
  onToggle(id: string): void;
  onManage(): void;
  onRetry(): void;
}

export function TaskTagsPanel({
  session,
  deviceId,
  disabled = false,
  expanded,
  onExpandedChange,
  renderCompact,
  showDone = true,
}: {
  session: RemoteSession;
  deviceId?: string;
  disabled?: boolean;
  expanded: boolean;
  onExpandedChange: (value: boolean) => void;
  renderCompact?: (state: TaskTagsCompactState) => ReactNode;
  showDone?: boolean;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const link = useDeviceLink();
  const { user } = useAuth();
  const owner = user?.id;
  const target =
    deviceId ??
    session.canonicalDeviceId ??
    session.deviceLinkDeviceId ??
    remoteSessionStore.getSessionDeviceId(session.id);
  const recovering = Boolean(target && link.recoveringDeviceIds.has(target));
  const blocked =
    recovering ||
    disabled ||
    !target ||
    link.status !== 'online' ||
    link.getPresenceAvailability(target) !== true;
  const cached = readTaskTagCatalog(owner, target);
  const [tags, setTags] = useState<TaskTag[]>(() => cached?.tags ?? []);
  const [hasCatalog, setHasCatalog] = useState(Boolean(cached));
  const [selected, setSelected] = useState(session.tags ?? []);
  const [busy, setBusy] = useState(!cached && !blocked);
  const [error, setError] = useState('');
  const [previewTagId, setPreviewTagId] = useState<string | null>(null);
  const previewTag = tags.find((tag) => tag.id === previewTagId);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const motion = useSharedValue({ from: -1, count: 0 });
  const dragY = useSharedValue(0);
  const dragScroll = useSharedValue(0);
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const listMaxHeight = Math.min(
    528,
    Math.max(132, windowHeight - insets.top - insets.bottom - 240),
  );
  const listRef = useRef<ScrollView>(null);
  const nameInput = useRef<NativeTextInput>(null);
  const viewportRef = useRef<View>(null);
  const scrollOffset = useRef(0);
  const drag = useRef<{
    id: string;
    from: number;
    to: number;
    expectedOrder: string[];
    startScroll: number;
    translation: number;
    absoluteY: number;
    top: number;
    height: number;
  } | null>(null);
  const dragFrame = useRef<number | null>(null);
  function cancelDrag() {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    drag.current = null;
    setDraggedId(null);
    cancelAnimation(dragY);
    motion.value = { from: -1, count: 0 };
    dragY.value = 0;
    dragScroll.value = 0;
  }
  useLayoutEffect(() => {
    cancelDrag();
    return () => {
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
      drag.current = null;
      cancelAnimation(dragY);
    };
  }, [tags, target, expanded, blocked]);
  useEffect(() => {
    scrollOffset.current = 0;
    setScrollY(0);
    listRef.current?.scrollTo({ y: 0, animated: false });
  }, [expanded, target]);
  const [editing, setEditing] = useState<TaskTag | null>(null);
  const [name, setName] = useState('');
  const editName = useRef('');
  const [color, setColor] = useState<TaskTagColor>('blue');
  const [pendingAttach, setPendingAttach] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [supportedColors, setSupportedColors] = useState<readonly TaskTagColor[]>(
    cached?.supportedColors ?? TASK_TAG_COLORS.slice(0, 7),
  );
  const [deletion, setDeletion] = useState<TaskTagResult['deletion']>();
  const requestGeneration = useRef(0);
  const catalogGeneration = useRef(0);
  const latestCatalog = useRef<TaskTag[]>(tags);
  const selectionGeneration = useRef(0);
  const selectedSnapshot = useRef(JSON.stringify(session.tags ?? []));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () =>
      subscribeRemoteTaskTagsChanged((source, value) => {
        if (source !== target && source !== session.deviceLinkDeviceId) return;
        catalogGeneration.current++;
        const catalog = normalizeTaskTags(value, 256);
        latestCatalog.current = catalog;
        if (target) writeTaskTagCatalog(owner, target, catalog);
        setHasCatalog(true);
        setTags((current) => (sameTaskTags(current, catalog) ? current : catalog));
        setSelected((current) => reconcileTaskTags(current, catalog));
      }),
    [owner, target, session.deviceLinkDeviceId],
  );
  async function run(request: TaskTagRequest, background = false) {
    if (blocked || !target) {
      setError('offline');
      return null;
    }
    const generation = ++requestGeneration.current;
    const catalogAtStart = catalogGeneration.current;
    const selectionAtStart = selectionGeneration.current;
    const cacheAtStart = taskTagCacheGeneration(target);
    const isCurrent = () =>
      alive.current &&
      generation === requestGeneration.current &&
      cacheAtStart === taskTagCacheGeneration(target);
    if (!background) setBusy(true);
    setError('');
    try {
      const r = await link.invoke<TaskTagResult>(target, 'local-db:task-tags:execute', [request], {
        preSend: () => {
          if (link.status !== 'online' || link.getPresenceAvailability(target) !== true)
            throw new Error('OFFLINE');
        },
      });
      if (!isCurrent()) return null;
      if (catalogAtStart === catalogGeneration.current) {
        latestCatalog.current = r.tags;
        writeTaskTagCatalog(
          owner,
          target,
          r.tags,
          r.supportedColors ?? TASK_TAG_COLORS.slice(0, 7),
        );
        setHasCatalog(true);
        setTags((current) => (sameTaskTags(current, r.tags) ? current : r.tags));
      }
      setSupportedColors(r.supportedColors ?? TASK_TAG_COLORS.slice(0, 7));
      const row = r.sessions.find((s) => s.sessionId === session.id);
      if (row && selectionAtStart === selectionGeneration.current) {
        const next =
          catalogAtStart === catalogGeneration.current
            ? row.tags
            : reconcileTaskTags(row.tags, latestCatalog.current);
        setSelected((current) => (sameTaskTags(current, next) ? current : next));
      }
      return r;
    } catch (e) {
      if (!isCurrent()) return null;
      setError(taskTagErrorKey(e, request.action));
      return null;
    } finally {
      if (alive.current && generation === requestGeneration.current) setBusy(false);
    }
  }
  useEffect(() => {
    const snapshot = readTaskTagCatalog(owner, target);
    setHasCatalog(Boolean(snapshot));
    setTags((current) =>
      sameTaskTags(current, snapshot?.tags ?? []) ? current : (snapshot?.tags ?? []),
    );
    latestCatalog.current = snapshot?.tags ?? [];
    setSupportedColors(snapshot?.supportedColors ?? TASK_TAG_COLORS.slice(0, 7));
    if (!blocked) void run({ action: 'get', sessionIds: [session.id] }, Boolean(snapshot));
    else setBusy(false);
    return () => {
      requestGeneration.current++;
    };
  }, [owner, session.id, target, blocked, link.connectionEpoch]);
  useEffect(() => {
    const sync = () => {
      const row = remoteSessionStore
        .getSessions()
        .find(
          (candidate) =>
            candidate.id === session.id &&
            ((candidate.canonicalDeviceId ??
              candidate.deviceLinkDeviceId ??
              remoteSessionStore.getSessionDeviceId(candidate.id)) === target ||
              candidate.deviceLinkDeviceId === target),
        );
      if (row) {
        const snapshot = JSON.stringify(row.tags ?? []);
        if (snapshot !== selectedSnapshot.current) {
          selectedSnapshot.current = snapshot;
          selectionGeneration.current++;
          setSelected(row.tags ?? []);
        }
      }
    };
    sync();
    return remoteSessionStore.subscribe(sync);
  }, [session.id, target]);
  useEffect(() => {
    const snapshot = JSON.stringify(session.tags ?? []);
    if (snapshot !== selectedSnapshot.current) {
      selectedSnapshot.current = snapshot;
      selectionGeneration.current++;
      setSelected(session.tags ?? []);
    }
  }, [session.tags]);
  function closeEditor() {
    setPendingAttach(null);
    setFormOpen(false);
    setEditing(null);
    setDeletion(undefined);
  }
  useEffect(() => {
    if (!expanded) closeEditor();
  }, [expanded]);
  function edit(tag: TaskTag | null) {
    cancelDrag();
    setFormOpen(true);
    setEditing(tag);
    editName.current = tag ? tagName(tag, t) : '';
    setName(editName.current);
    setColor(tag?.color === 'none' ? 'white' : (tag?.color ?? 'blue'));
    setDeletion(undefined);
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ y: 0, animated: false });
      nameInput.current?.focus();
    });
  }
  async function reorder(id: string, to: number, expectedOrder = tags.map((tag) => tag.id)) {
    const from = expectedOrder.indexOf(id);
    if (from < 0 || to < 0 || to >= expectedOrder.length || from === to) return;
    const tagIds = [...expectedOrder];
    tagIds.splice(from, 1);
    tagIds.splice(to, 0, id);
    const before = tags;
    const catalogAtStart = catalogGeneration.current;
    setTags(tagIds.map((tagId) => before.find((tag) => tag.id === tagId)!));
    const result = await run({ action: 'reorder', tagIds, expectedOrder });
    if (!result && alive.current && catalogAtStart === catalogGeneration.current) setTags(before);
    if (result && editing) setEditing(result.tags.find((tag) => tag.id === editing.id) ?? null);
  }
  function trackDrag() {
    const active = drag.current;
    if (!active) return;
    const direction =
      active.height > 0
        ? active.absoluteY < active.top + 40
          ? -1
          : active.absoluteY > active.top + active.height - 40
            ? 1
            : 0
        : 0;
    if (direction) {
      const next = Math.max(
        0,
        Math.min(
          active.expectedOrder.length * 44 - active.height,
          scrollOffset.current + direction * 6,
        ),
      );
      scrollOffset.current = next;
      dragScroll.value = next - active.startScroll;
      listRef.current?.scrollTo({ y: next, animated: false });
    }
    const to = Math.max(
      0,
      Math.min(
        active.expectedOrder.length - 1,
        active.from +
          Math.round((active.translation + scrollOffset.current - active.startScroll) / 44),
      ),
    );
    if (to !== active.to) {
      active.to = to;
    }
    dragFrame.current = requestAnimationFrame(trackDrag);
  }
  function startDrag(tagId: string, absoluteY: number) {
    if (busy || blocked) return;
    const expectedOrder = tags.map((tag) => tag.id);
    const from = expectedOrder.indexOf(tagId);
    drag.current = {
      id: tagId,
      from,
      to: from,
      expectedOrder,
      startScroll: scrollOffset.current,
      translation: 0,
      absoluteY,
      top: 0,
      height: 0,
    };
    setDraggedId(tagId);
    motion.value = { from, count: expectedOrder.length };
    dragY.value = 0;
    dragScroll.value = 0;
    viewportRef.current?.measureInWindow((_x, y, _width, height) => {
      if (drag.current) {
        drag.current.top = y;
        drag.current.height = height;
      }
    });
    dragFrame.current = requestAnimationFrame(trackDrag);
  }
  function moveDrag(translation: number, absoluteY: number) {
    if (drag.current) {
      drag.current.translation = translation;
      drag.current.absoluteY = absoluteY;
    }
  }
  function finishDrag(success: boolean) {
    const active = drag.current;
    if (active)
      active.to = Math.max(
        0,
        Math.min(
          active.expectedOrder.length - 1,
          active.from +
            Math.round((active.translation + scrollOffset.current - active.startScroll) / 44),
        ),
      );
    if (!active || !success) {
      cancelDrag();
      return;
    }
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    // Snap visually before committing the reordered array, so release never jumps back.
    dragY.value = withTiming(
      (active.to - active.from) * 44 - dragScroll.value,
      { duration: motionDuration.fast, easing: Easing.bezier(...motionEasing.move), reduceMotion: ReduceMotion.System },
      (finished) => {
        if (finished) runOnJS(commitDrop)(active.id, active.to, active.expectedOrder);
      },
    );
  }
  function commitDrop(id: string, to: number, expectedOrder: string[]) {
    if (drag.current?.id !== id || blocked) {
      cancelDrag();
      return;
    }
    if (expectedOrder.indexOf(id) === to) {
      cancelDrag();
      return;
    }
    void reorder(id, to, expectedOrder);
  }
  const textStyle = { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body };
  const action = (
    label: string,
    onPress: () => void,
    inactive = false,
    primary = false,
    tone: 'default' | 'secondary' | 'danger' = 'default',
    local = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy || (!local && blocked) || inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: radius.pill,
        borderWidth: tone === 'default' ? 0 : 1,
        borderColor: tone === 'danger' ? colors.destructive : colors.border,
        backgroundColor: primary ? colors.cta : undefined,
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        opacity: busy || (!local && blocked) || inactive ? 0.4 : pressed ? 0.75 : 1,
      })}
    >
      <Text
        style={[
          textStyle,
          primary
            ? { color: colors.ctaText }
            : tone === 'danger'
              ? { color: colors.destructive }
              : {},
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
  const toggle = (tag: TaskTag) =>
    void run({
      action: selected.some((s) => s.id === tag.id) ? 'detach' : 'attach',
      sessionIds: [session.id],
      tagIds: [tag.id],
    });
  const canManage = !busy && error !== 'unavailable' && (!blocked || hasCatalog);
  // The native shortcut row shares transport, cache and mutations with the editor.
  if (!expanded && renderCompact) {
    const reason = blocked ? 'offline' : error || (!hasCatalog && busy ? 'loading' : '');
    return renderCompact({
      tags:
        error === 'unavailable'
          ? []
          : tags.map((tag) => ({
              id: tag.id,
              name: tagName(tag, t),
              color: colorFor(tag, colors),
              checkColor:
                tag.color === 'white' || tag.color === 'none'
                  ? colors.taskTagWhiteCheck
                  : colors.taskTagWhite,
              selected: selected.some((item) => item.id === tag.id),
            })),
      disabled: busy || blocked,
      message: reason ? t(`taskTags.${reason}`) : undefined,
      canRetry: !blocked && !busy && Boolean(error) && error !== 'unavailable',
      canManage,
      onToggle: (id) => {
        const tag = tags.find((item) => item.id === id);
        if (tag && !busy && !blocked) toggle(tag);
      },
      onManage: () => onExpandedChange(true),
      onRetry: () => {
        void run({ action: 'get', sessionIds: [session.id] }, hasCatalog);
      },
    });
  }
  if (!formOpen && (error === 'unavailable' || (!hasCatalog && (error || blocked || busy)))) {
    const reason = blocked ? 'offline' : error || 'loading';
    return (
      <View style={{ width: '100%', paddingVertical: spacing.md, gap: spacing.xs }}>
        <Text style={{ color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body }}>
          {t('taskTags.title')}
        </Text>
        <Text
          accessibilityRole={reason === 'loadFailed' ? 'alert' : 'text'}
          style={{
            color: colors.textSecondary,
            fontSize: typeScale.caption,
            lineHeight: lineHeight.bodySmall,
          }}
        >
          {t(`taskTags.${reason}`)}
        </Text>
        {!blocked && reason !== 'unavailable' && reason !== 'loading' && (
          <Pressable
            disabled={busy}
            accessibilityRole="button"
            onPress={() => {
              void run({ action: 'get', sessionIds: [session.id] });
            }}
            style={{
              minHeight: 44,
              justifyContent: 'center',
              alignSelf: 'flex-start',
            }}
          >
            <Text style={{ color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body }}>
              {t('taskTags.retry')}
            </Text>
          </Pressable>
        )}
        {expanded && showDone && (
          <Pressable
            accessibilityRole="button"
            onPress={() => onExpandedChange(false)}
            style={{
              minHeight: 44,
              justifyContent: 'center',
              alignSelf: 'flex-end',
            }}
          >
            <Text style={{ color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body }}>
              {t('taskTags.done')}
            </Text>
          </Pressable>
        )}
      </View>
    );
  }
  return (
    <View
      style={{
        width: '100%',
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.border,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          minHeight: expanded ? 44 : 24,
          marginBottom: expanded ? spacing.sm : 0,
        }}
      >
        {formOpen && !deletion && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('taskTags.back')}
            onPress={closeEditor}
            disabled={busy}
            style={{
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.pill,
            }}
          >
            <ArrowLeft size={iconSize.action} color={colors.textPrimary} />
          </Pressable>
        )}
        <Text
          style={{
            flex: 1,
            color: expanded ? colors.textPrimary : colors.textSecondary,
            fontSize: expanded ? typeScale.body : typeScale.caption,
            fontWeight: expanded ? fontWeight.semibold : fontWeight.regular,
          }}
        >
          {deletion
            ? t('taskTags.delete')
            : previewTag && !expanded
              ? t(
                  selected.some((tag) => tag.id === previewTag.id)
                    ? 'taskTags.removeLabel'
                    : 'taskTags.addLabel',
                  { name: tagName(previewTag, t) },
                )
              : t(formOpen ? (editing ? 'taskTags.editTitle' : 'taskTags.add') : 'taskTags.title')}
        </Text>
        {expanded && !formOpen && (
          <Text style={{ color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption }}>
            {t('taskTags.selectedCount', { count: selected.length })}
          </Text>
        )}
      </View>
      {!expanded ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            flexGrow: 1,
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {tags.slice(0, 7).map((tag) => (
            <Pressable
              key={tag.id}
              accessibilityRole="button"
              accessibilityLabel={tagName(tag, t)}
              accessibilityState={{
                selected: selected.some((s) => s.id === tag.id),
                disabled: busy || blocked,
              }}
              disabled={busy || blocked}
              onPressIn={() => setPreviewTagId(tag.id)}
              onLongPress={() => setPreviewTagId(tag.id)}
              onPress={() => toggle(tag)}
              style={{
                minHeight: 44,
                minWidth: 44,
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View
                style={{
                  padding: spacing.xs,
                  borderWidth: 0,
                  borderRadius: radius.pill,
                }}
              >
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: radius.pill,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: colorFor(tag, colors),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {selected.some((s) => s.id === tag.id) && (
                    <Text
                      style={{
                        color:
                          tag.color === 'white' || tag.color === 'none'
                            ? colors.taskTagWhiteCheck
                            : colors.taskTagWhite,
                      }}
                    >
                      ✓
                    </Text>
                  )}
                </View>
              </View>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('taskTags.more')}
            disabled={!canManage}
            onPress={() => onExpandedChange(true)}
            style={{
              minHeight: 44,
              minWidth: 44,
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: colors.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MoreHorizontal size={iconSize.xs} color={colors.textSecondary} />
            </View>
          </Pressable>
        </ScrollView>
      ) : (
        <View ref={viewportRef} collapsable={false}>
          <ScrollView
            ref={listRef}
            scrollEnabled={!draggedId}
            scrollEventThrottle={16}
            onScroll={(event) => {
              scrollOffset.current = event.nativeEvent.contentOffset.y;
              setScrollY(event.nativeEvent.contentOffset.y);
            }}
            onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
            onContentSizeChange={(_width, height) => setContentHeight(height)}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingRight: 12 }}
            style={{ maxHeight: listMaxHeight }}
            keyboardShouldPersistTaps="handled"
          >
            {!formOpen && !tags.length && !error && !blocked && (
              <Text
                accessibilityRole="text"
                style={{
                  color: colors.textSecondary,
                  textAlign: 'center',
                  paddingVertical: spacing.xl,
                  fontSize: typeScale.body,
                  lineHeight: lineHeight.body,
                }}
              >
                {t(busy ? 'taskTags.loading' : 'taskTags.empty')}
              </Text>
            )}
            {!formOpen &&
              tags.map((tag, index) => (
                <TagSortRow
                  key={tag.id}
                  index={index}
                  motion={motion}
                  dragY={dragY}
                  dragScroll={dragScroll}
                >
                  <TagDragHandle
                    label={t('taskTags.reorderLabel', {
                      name: tagName(tag, t),
                    })}
                    hint={t('taskTags.reorderHint')}
                    disabled={busy || blocked}
                    dragY={dragY}
                    onStart={(y) => startDrag(tag.id, y)}
                    onMove={moveDrag}
                    onEnd={finishDrag}
                    onStep={(delta) => {
                      void reorder(tag.id, index + delta);
                    }}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={tagName(tag, t)}
                    accessibilityState={{
                      selected: selected.some((item) => item.id === tag.id),
                    }}
                    disabled={busy || blocked}
                    onPress={() => toggle(tag)}
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: radius.pill,
                        borderWidth: 0.5,
                        borderColor: colors.border,
                        backgroundColor: colorFor(tag, colors),
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {selected.some((item) => item.id === tag.id) && (
                        <Text
                          style={{
                            color:
                              tag.color === 'white' || tag.color === 'none'
                                ? colors.taskTagWhiteCheck
                                : colors.taskTagWhite,
                          }}
                        >
                          ✓
                        </Text>
                      )}
                    </View>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || blocked}
                    onPress={() => toggle(tag)}
                    style={{ flex: 1, height: 44, justifyContent: 'center' }}
                  >
                    <Text numberOfLines={1} style={textStyle}>
                      {tagName(tag, t)}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('taskTags.editLabel', {
                      name: tagName(tag, t),
                    })}
                    disabled={busy || blocked}
                    onPress={() => edit(tag)}
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Pencil size={iconSize.md} color={colors.textSecondary} />
                  </Pressable>
                </TagSortRow>
              ))}
            {formOpen && !deletion && (
              <View style={{ gap: spacing.md, paddingBottom: spacing.sm }}>
                <Text style={textStyle}>{t('taskTags.name')}</Text>
                <TextInput
                  ref={nameInput}
                  accessibilityLabel={t('taskTags.name')}
                  editable={!busy && !blocked && !pendingAttach}
                  value={name}
                  onChangeText={setName}
                  maxLength={80}
                  style={[
                    textStyle,
                    {
                      minHeight: 44,
                      borderWidth: 1,
                      borderColor: colors.border,
                      borderRadius: radius.control,
                      paddingHorizontal: spacing.md,
                      backgroundColor: colors.surface,
                    },
                  ]}
                />
                <Text style={textStyle}>{t('taskTags.color')}</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                  {TASK_TAG_COLORS.map((c) => (
                    <Pressable
                      key={c}
                      accessibilityRole="button"
                      accessibilityLabel={t(`taskTags.${c}`)}
                      accessibilityState={{ selected: color === c }}
                      disabled={
                        busy || blocked || Boolean(pendingAttach) || !supportedColors.includes(c)
                      }
                      onPress={() => setColor(c)}
                      style={{
                        width: '16.666667%',
                        minHeight: 44,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: supportedColors.includes(c) ? 1 : 0.3,
                        borderColor: colors.textSecondary,
                        borderRadius: radius.pill,
                      }}
                    >
                      <View
                        style={{
                          width: 24,
                          height: 24,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderWidth: 0.5,
                          borderColor: colors.border,
                          borderRadius: radius.pill,
                          backgroundColor: colorFor({ color: c } as TaskTag, colors),
                        }}
                      >
                        {color === c && (
                          <Text
                            style={{
                              color: c === 'white' ? colors.taskTagWhiteCheck : colors.taskTagWhite,
                            }}
                          >
                            ✓
                          </Text>
                        )}
                      </View>
                    </Pressable>
                  ))}
                </View>
                <Text
                  style={{
                    color: colors.textSecondary,
                    fontSize: typeScale.caption,
                    lineHeight: lineHeight.caption,
                  }}
                >
                  {t(
                    supportedColors.length < TASK_TAG_COLORS.length
                      ? 'taskTags.unavailable'
                      : editing
                        ? 'taskTags.editHint'
                        : 'taskTags.addHint',
                  )}
                </Text>
                <View
                  style={{
                    flexDirection: 'row-reverse',
                    flexWrap: 'wrap',
                    justifyContent: 'flex-start',
                    alignItems: 'center',
                    gap: spacing.sm,
                    paddingTop: spacing.sm,
                  }}
                >
                  {action(
                    t(editing ? 'taskTags.save' : 'taskTags.create'),
                    () => {
                      void (async () => {
                        if (pendingAttach) {
                          const attached = await run({
                            action: 'attach',
                            sessionIds: [session.id],
                            tagIds: [pendingAttach],
                          });
                          if (attached) closeEditor();
                          return;
                        }
                        const r = await run(
                          editing
                            ? {
                                action: 'update',
                                tagId: editing.id,
                                revision: taskTagEditRevision(editing, latestCatalog.current),
                                name: name === editName.current ? undefined : name,
                                nameCustomized:
                                  name === editName.current ? undefined : true,
                                color:
                                  editing.color === 'none' &&
                                  color === 'white' &&
                                  !supportedColors.includes('white')
                                    ? undefined
                                    : color,
                              }
                            : { action: 'create', name, color },
                        );
                        if (r) {
                          const created = !editing
                            ? r.tags.find((tag) => tag.name === name.trim())
                            : r.tags.find((tag) => tag.id === pendingAttach);
                          if (created) {
                            setEditing(created);
                            setPendingAttach(created.id);
                            const attached = await run({
                              action: 'attach',
                              sessionIds: [session.id],
                              tagIds: [created.id],
                            });
                            if (!attached) return;
                          }
                          closeEditor();
                        }
                      })();
                    },
                    !name.trim() ||
                      (!supportedColors.includes(color) &&
                        !(editing?.color === 'none' && color === 'white')),
                    true,
                  )}
                  {action(t('taskTags.cancel'), closeEditor, false, false, 'secondary', true)}
                  {editing && (
                    <View style={{ flexDirection: 'row', marginRight: 'auto' }}>
                      {action(t('taskTags.delete'), () => {
                        void run({
                          action: 'previewDelete',
                          tagId: editing.id,
                        }).then((r) => {
                          if (r) setDeletion(r.deletion);
                        });
                      })}
                    </View>
                  )}
                </View>
              </View>
            )}
            {deletion && (
              <View style={{ gap: spacing.xl, paddingVertical: spacing.sm }}>
                <Text
                  style={[
                    textStyle,
                    {
                      color: colors.textSecondary,
                      lineHeight: lineHeight.bodyRelaxed,
                    },
                  ]}
                >
                  {t('taskTags.deleteConfirm', {
                    name: editing ? tagName(editing, t) : '',
                    count: deletion.count,
                  })}
                </Text>
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    justifyContent: 'flex-end',
                    gap: spacing.sm,
                  }}
                >
                  {action(
                    t('taskTags.cancel'),
                    () => setDeletion(undefined),
                    false,
                    false,
                    'secondary',
                    true,
                  )}
                  {action(
                    t('taskTags.delete'),
                    () => {
                      void run({
                        action: 'delete',
                        tagId: deletion.tagId,
                        revision: deletion.revision,
                        expectedCount: deletion.count,
                      }).then((r) => {
                        if (r) closeEditor();
                      });
                    },
                    false,
                    false,
                    'danger',
                  )}
                </View>
              </View>
            )}
          </ScrollView>
          {contentHeight > viewportHeight + 1 && viewportHeight > 0 && (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                right: 2,
                top: 0,
                bottom: 0,
                width: 4,
              }}
            >
              <View
                style={{
                  width: 4,
                  borderRadius: radius.pill,
                  backgroundColor: colors.textSecondary,
                  height: Math.max(24, (viewportHeight * viewportHeight) / contentHeight),
                  transform: [
                    {
                      translateY:
                        Math.max(0, Math.min(1, scrollY / (contentHeight - viewportHeight))) *
                        (viewportHeight -
                          Math.max(24, (viewportHeight * viewportHeight) / contentHeight)),
                    },
                  ],
                }}
              />
            </View>
          )}
        </View>
      )}
      {expanded && !formOpen && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            borderTopWidth: 1,
            borderColor: colors.border,
            paddingTop: spacing.xs,
          }}
        >
          {action(t('taskTags.add'), () => edit(null))}
          {showDone && (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                onExpandedChange(false);
                closeEditor();
              }}
              style={{
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: spacing.sm,
                borderRadius: radius.pill,
                backgroundColor: colors.cta,
                opacity: busy ? 0.4 : 1,
              }}
            >
              <Text style={[textStyle, { color: colors.ctaText }]}>{t('taskTags.done')}</Text>
            </Pressable>
          )}
        </View>
      )}
      {(error || blocked) && (
        <Text
          accessibilityRole="alert"
          style={{
            color: colors.textSecondary,
            fontSize: typeScale.caption,
            lineHeight: lineHeight.bodySmall,
            paddingVertical: spacing.xs,
            marginTop: spacing.sm,
          }}
        >
          {t(`taskTags.${blocked ? 'offline' : error}`)}
        </Text>
      )}
      {!blocked && error === 'loadFailed' && (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void run({ action: 'get', sessionIds: [session.id] }, hasCatalog)}
          style={{
            minHeight: 44,
            justifyContent: 'center',
            alignSelf: 'flex-start',
          }}
        >
          <Text style={{ color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body }}>
            {t('taskTags.retry')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function TagDragHandle(props: {
  dragY: SharedValue<number>;
  label: string;
  hint: string;
  disabled: boolean;
  onStart: (absoluteY: number) => void;
  onMove: (translationY: number, absoluteY: number) => void;
  onEnd: (success: boolean) => void;
  onStep: (delta: number) => void;
}) {
  const { colors } = useTheme();
  const latest = useRef(props);
  latest.current = props;
  const start = useCallback((y: number) => latest.current.onStart(y), []);
  const move = useCallback(
    (translation: number, y: number) => latest.current.onMove(translation, y),
    [],
  );
  const finish = useCallback((success: boolean) => latest.current.onEnd(success), []);
  const dragY = props.dragY;
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!props.disabled)
        .activateAfterLongPress(380)
        .onStart((event) => {
          runOnJS(start)(event.absoluteY);
        })
        .onUpdate((event) => {
          dragY.value = event.translationY;
          runOnJS(move)(event.translationY, event.absoluteY);
        })
        .onFinalize((event, success) => {
          runOnJS(move)(event.translationY, event.absoluteY);
          runOnJS(finish)(success);
        }),
    [props.disabled, dragY, start, move, finish],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.label}
        accessibilityHint={props.hint}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => {
          if (!props.disabled) props.onStep(event.nativeEvent.actionName === 'increment' ? 1 : -1);
        }}
        style={{
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <GripVertical size={iconSize.md} color={colors.textSecondary} />
      </View>
    </GestureDetector>
  );
}

function TagSortRow({
  index,
  motion,
  dragY,
  dragScroll,
  children,
}: {
  index: number;
  motion: SharedValue<{ from: number; count: number }>;
  dragY: SharedValue<number>;
  dragScroll: SharedValue<number>;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  const animatedStyle = useAnimatedStyle(() => {
    const { from, count } = motion.value;
    if (from < 0)
      return {
        transform: [{ translateY: 0 }],
        zIndex: 0,
        backgroundColor: 'transparent',
      };
    const offset = Math.max(
      -from * 44,
      Math.min((count - from - 1) * 44, dragY.value + dragScroll.value),
    );
    const to = from + Math.round(offset / 44);
    const shift = from < index && index <= to ? -44 : to <= index && index < from ? 44 : 0;
    return {
      transform: [
        {
          translateY:
            index === from
              ? offset
              : withTiming(shift, {
                  duration: motionDuration.fast,
                  easing: Easing.bezier(...motionEasing.move),
                  reduceMotion: ReduceMotion.System,
                }),
        },
      ],
      zIndex: index === from ? 1 : 0,
      backgroundColor: index === from ? colors.surface : 'transparent',
    };
  });
  return (
    <Animated.View
      style={[
        {
          height: 44,
          flexDirection: 'row',
          alignItems: 'center',
          borderRadius: radius.pill,
        },
        animatedStyle,
      ]}
    >
      {children}
    </Animated.View>
  );
}
