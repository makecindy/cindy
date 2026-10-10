import { TodoDateInput } from './TodoDateInput';
import { CompanionTodoRow } from './CompanionTodoRow';
import { makeTodoStyles as makeStyles } from './companionTodoStyles';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react-native';
import { randomUUID } from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource, invokeRemoteResourceAction } from '@/device-link/remoteResources';
import { Text, TextInput } from '@/components/AppText';
import {
  iconSize,
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';
import { CompanionSheet } from './CompanionSheet';
import {
  effectiveTodoDeadline,
  scheduleTodoDeferralRefresh,
  todoDateLabel,
  todoOverdue,
  todoLocalDate,
  type TeammateTodo,
  type TodoPatch,
  type TodoListQuery,
} from '@cindy/maker-shared/teammate-todo';

interface Props {
  visible: boolean;
  onClose(): void;
  deviceId: string;
  deviceName: string;
  botId: string;
  online: boolean;
}
interface Page {
  items: TeammateTodo[];
  total: number;
  completedTotal: number;
  nextDeferredAt?: string | null;
  offset: number;
  limit: number;
}
export function CompanionTodos(props: Props) {
  const { accountGeneration } = useAuth();
  return (
    <CompanionTodosContent
      key={`${accountGeneration}:${props.deviceId}:${props.botId}`}
      {...props}
    />
  );
}
function CompanionTodosContent({ visible, onClose, deviceId, deviceName, botId, online }: Props) {
  const { t, i18n } = useTranslation();
  const tr = (key: string, args?: Record<string, unknown>): string =>
    String(t('devices.teammateTodo.' + key, args));
  const { invoke, openLink, onRemoteResourceChanged } = useDeviceLink();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [page, setPage] = useState<Page>({
      items: [],
      total: 0,
      completedTotal: 0,
      offset: 0,
      limit: 25,
    }),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState<TodoListQuery>({
      view: 'open',
      order: 'due',
    }),
    [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [detail, setDetail] = useState<TeammateTodo | null>(null),
    [editing, setEditing] = useState<false | 'edit' | 'deadline' | 'complete' | 'later'>(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [showActions, setShowActions] = useState(false);
  const pending = useRef(false);
  const operationEpoch = useRef(0);
  const formRevision = useRef<number | undefined>(undefined);
  const epoch = useRef(0),
    binding = useRef(''),
    mounted = useRef(true);
  binding.current = `${deviceId}:${botId}:${visible}:${online}`;
  useEffect(() => {
    // A lost link invalidates this panel's UI request, not the host's operation.
    // Do not replay it on reconnect; reload the host record instead.
    operationEpoch.current++;
    pending.current = false;
    setBusy(false);
    setLoading(false);
  }, [deviceId, botId, visible, online]);
  const readingOrder = useRef<{ key: string; ids: string[] }>({ key: '', ids: [] });
  const ref = { collectionId: 'teammates', kind: 'bot', id: 'todos:' + botId };
  const reload = useCallback(async () => {
    if (!visible || !online) return;
    const scope = binding.current,
      n = ++epoch.current;
    setLoading(true);
    try {
      await openLink(deviceId);
      const resource = await getRemoteResource(
        invoke,
        { deviceId, deviceName },
        ref,
        i18n.language,
        ['teammate-todos'],
        JSON.stringify({ query, offset, ...filter }),
      );
      if (!mounted.current || scope !== binding.current || n !== epoch.current) return;
      const data = resource.blocks?.find((b) => b.primitive === 'teammate-todos')?.data as
        Page | undefined;
      if (
        !data ||
        !Array.isArray(data.items) ||
        !Number.isSafeInteger(data.total) ||
        data.items.length > 25
      )
        throw new Error('INVALID_RESPONSE');
      const orderKey = JSON.stringify({ scope, query, offset: data.offset, ...filter });
      if (readingOrder.current.key === orderKey) {
        const ranks = new Map(readingOrder.current.ids.map((id, index) => [id, index]));
        data.items = [...data.items].sort(
          (a, b) =>
            (ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        );
      }
      readingOrder.current = { key: orderKey, ids: data.items.map((item) => item.id) };
      setPage(data);
      setDetail((old) => (old ? (data.items.find((x) => x.id === old.id) ?? old) : null));
      setError('');
    } catch {
      if (mounted.current && scope === binding.current) setError('error');
    } finally {
      if (mounted.current && scope === binding.current) setLoading(false);
    }
  }, [
    visible,
    online,
    deviceId,
    deviceName,
    invoke,
    openLink,
    query,
    offset,
    filter,
    i18n.language,
  ]);
  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => void reload(), query ? 250 : 0);
    return () => {
      clearTimeout(timer);
      epoch.current++;
    };
  }, [reload]);
  useEffect(() => {
    if (!visible || !online || !page.nextDeferredAt) return;
    // A mounted-list visibility refresh, never a background reminder or action.
    return scheduleTodoDeferralRefresh(page.nextDeferredAt, () => void reload());
  }, [visible, online, page.nextDeferredAt, reload]);
  useEffect(() => {
    if (!visible || !online) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reload();
    });
    return () => subscription.remove();
  }, [visible, online, reload]);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(
    () =>
      onRemoteResourceChanged((id, payload) => {
        if (
          id === deviceId &&
          payload.collectionId === 'teammates' &&
          (!payload.resourceRefs ||
            payload.resourceRefs.some((ref) => ref.id === botId || ref.id === 'todos:' + botId))
        )
          void reload();
      }),
    [onRemoteResourceChanged, deviceId, botId, reload],
  );
  useEffect(() => {
    if (!visible) {
      setDetail(null);
      setEditing(false);
      setShowActions(false);
    }
  }, [visible]);
  const run = async (input: Record<string, unknown>, actionId = 'todo-update') => {
    if (pending.current || !online) return;
    pending.current = true;
    setBusy(true);
    const scope = binding.current;
    const operation = ++operationEpoch.current;
    const current = () =>
      mounted.current && scope === binding.current && operation === operationEpoch.current;
    try {
      await openLink(deviceId);
      if (!current()) return;
      await invokeRemoteResourceAction(
        invoke,
        { deviceId, deviceName },
        { collectionId: 'teammates', resourceRef: ref, actionId, input },
        i18n.language,
      );
      if (current()) {
        setEditing(false);
        setDetail(null);
        setShowActions(false);
        await reload();
      }
    } catch (e) {
      if (current()) setError(String(e).includes('CONFLICT') ? 'conflict' : 'error');
    } finally {
      if (operation === operationEpoch.current) {
        pending.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const update = (item: TeammateTodo, patch: TodoPatch) =>
    void run({ ...patch, id: item.id, expectedRevision: item.revision });
  const label = (x: TeammateTodo) =>
    x.status === 'done'
      ? tr('evidence')
      : x.action
        ? tr(
            x.action.state === 'failed'
              ? 'failed'
              : x.action.state === 'accepted'
                ? 'accepted'
                : x.action.state === 'unknown'
                  ? 'unknown'
                  : 'received',
          )
        : x.legacyId && x.next?.label === 'Continue'
          ? tr('continue')
          : (x.next?.label ?? tr('view'));
  const act = (x: TeammateTodo, confirmed = false) => {
    if (
      x.status === 'done' ||
      !x.next ||
      x.next.kind === 'view' ||
      (x.next.kind === 'decide' && !confirmed) ||
      (x.action && x.action.state !== 'failed')
    ) {
      setDetail(x);
      setEditing(false);
      setShowActions(false);
      return;
    }
    void run(
      { id: x.id, revision: x.revision, requestId: randomUUID(), locale: i18n.language },
      'todo-act',
    );
  };
  const edit = (x: TeammateTodo | null, mode: NonNullable<typeof editing>) => {
    formRevision.current = x?.revision;
    setDetail(x);
    setEditing(mode);
    setShowActions(false);
    const d = x ? effectiveTodoDeadline(x) : null;
    setForm({
      title: x?.title ?? '',
      outcome: x?.outcome ?? '',
      progress: x?.progress ?? '',
      date: d?.at
        ? todoLocalDate(new Date(d.at), Intl.DateTimeFormat().resolvedOptions().timeZone)
        : (d?.date ?? ''),
      time: d?.at ?? '',
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      summary: '',
      ref: '',
      until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  };
  const menu = (x: TeammateTodo) => {
    setDetail(x);
    setEditing(false);
    setShowActions(true);
  };
  const button = (text: string, fn: () => void, style?: object, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityState={{ disabled: disabled || busy || !online }}
      disabled={disabled || busy || !online}
      onPress={fn}
      style={[styles.button, style, (disabled || busy || !online) && styles.disabled]}
    >
      <Text numberOfLines={1} style={styles.buttonText}>
        {text}
      </Text>
    </Pressable>
  );
  const field = (key: string, label = key) => (
    <View key={key} style={styles.field}>
      <Text style={styles.caption}>{tr(label)}</Text>
      <TextInput
        accessibilityLabel={tr(label)}
        value={form[key] ?? ''}
        onChangeText={(value) => setForm({ ...form, [key]: value })}
        style={styles.input}
        multiline={['outcome', 'summary', 'progress'].includes(key)}
        autoCapitalize="none"
      />
    </View>
  );
  const save = () => {
    const patch: TodoPatch =
      editing === 'edit'
        ? { title: form.title, outcome: form.outcome, progress: form.progress }
        : editing === 'deadline'
          ? {
              deadlineOverride: {
                value: form.date
                  ? {
                      kind: form.time ? 'instant' : 'date',
                      date: form.date,
                      timeZone: form.zone,
                      ...(form.time ? { at: form.time } : {}),
                    }
                  : null,
              },
            }
          : editing === 'complete'
            ? {
                operation: 'complete',
                completion: {
                  summary: form.summary,
                  ...(form.ref ? { ref: form.ref } : {}),
                },
              }
            : { operation: 'later', until: form.until };
    if (detail) void run({ ...patch, id: detail.id, expectedRevision: formRevision.current });
    else
      void run({
        ...patch,
        key: 'user:' + randomUUID(),
        origin: 'assigned',
        next: { kind: 'advance', label: tr('continue'), instruction: form.outcome },
      });
  };
  const info = (key: string, value: string | undefined) =>
    value ? (
      <View style={styles.field}>
        <Text style={styles.caption}>{tr(key)}</Text>
        <Text selectable style={styles.body}>
          {value}
        </Text>
      </View>
    ) : null;
  return (
    <CompanionSheet
      visible={visible}
      title={tr('title')}
      onClose={onClose}
      onBack={
        detail || editing || showActions
          ? () => {
              setDetail(null);
              setEditing(false);
              setShowActions(false);
            }
          : undefined
      }
      preventDismiss={busy}
      testID="companion.todos"
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      >
        {!online && (
          <Text accessibilityRole="alert" style={styles.body}>
            {t('devices.resources.hostOffline')}
          </Text>
        )}
        {!!error && (
          <View>
            <Text accessibilityRole="alert" style={styles.body}>
              {tr(error)}
            </Text>
            {button(tr('retry'), () => void reload())}
          </View>
        )}
        {showActions && detail ? (
          <>
            {button(tr('edit'), () => edit(detail, 'edit'))}
            {button(tr('deadline'), () => edit(detail, 'deadline'))}
            {button(tr(detail.status === 'done' ? 'reopen' : 'complete'), () =>
              detail.status === 'done'
                ? update(detail, { operation: 'reopen' })
                : edit(detail, 'complete'),
            )}
            {detail.decision ? (
              button(tr('restore'), () => update(detail, { operation: 'restore' }))
            ) : (
              <>
                {button(tr('later'), () => edit(detail, 'later'))}
                {button(tr('delete'), () => update(detail, { operation: 'delete' }))}
                {button(tr('mute'), () => update(detail, { operation: 'mute' }))}
              </>
            )}
            {button(tr('cancel'), () => setShowActions(false))}
          </>
        ) : editing ? (
          <>
            {editing === 'edit' ? (
              ['title', 'outcome', 'progress'].map((key) =>
                field(key, key === 'title' ? 'name' : key),
              )
            ) : editing === 'complete' ? (
              ['summary', 'ref'].map((key) => field(key, key === 'ref' ? 'link' : key))
            ) : editing === 'deadline' ? (
              <>
                {form.date ? (
                  <TodoDateInput
                    label={tr('date')}
                    kind="date"
                    value={
                      form.time
                        ? new Date(form.time)
                        : form.date
                          ? new Date(form.date + 'T12:00:00')
                          : new Date()
                    }
                    onChange={(date) =>
                      setForm({
                        ...form,
                        date: todoLocalDate(date, form.zone),
                        ...(form.time ? { time: date.toISOString() } : {}),
                      })
                    }
                  />
                ) : (
                  button(tr('deadline'), () =>
                    setForm({
                      ...form,
                      date: todoLocalDate(new Date(), form.zone),
                    }),
                  )
                )}
                {form.time ? (
                  <>
                    <TodoDateInput
                      label={tr('time')}
                      kind="time"
                      value={new Date(form.time)}
                      onChange={(date) =>
                        setForm({
                          ...form,
                          date: todoLocalDate(date, form.zone),
                          time: date.toISOString(),
                        })
                      }
                    />
                    {button(tr('dateOnly'), () => setForm({ ...form, time: '' }))}
                  </>
                ) : (
                  button(tr('addTime'), () => {
                    const date = form.date ? new Date(form.date + 'T12:00:00') : new Date();
                    setForm({
                      ...form,
                      date: todoLocalDate(date, form.zone),
                      time: date.toISOString(),
                    });
                  })
                )}
                {info('zone', form.zone)}
              </>
            ) : (
              <TodoDateInput
                label={tr('until')}
                kind="datetime"
                value={new Date(form.until)}
                onChange={(date) => setForm({ ...form, until: date.toISOString() })}
              />
            )}
            {editing === 'deadline' && (
              <>
                {button(tr('clearDate'), () => setForm({ ...form, date: '', time: '' }))}
                {detail?.deadlineCandidate && (
                  <>
                    {info('deadlineReason', detail.deadlineCandidate.reason)}
                    {button(tr('confirmDate'), () =>
                      update(detail, { operation: 'confirm-deadline' }),
                    )}
                  </>
                )}
              </>
            )}
            {editing === 'later' && info('laterConflict', tr('laterConflict'))}
            {button(tr('save'), save)}
            {button(tr('cancel'), () => setEditing(false))}
          </>
        ) : detail ? (
          <>
            <Text selectable style={styles.title}>
              {detail.title}
            </Text>
            {info('progress', detail.progress)}
            {info('outcome', detail.outcome)}
            {info('value', detail.value)}
            {info('next', detail.next?.label)}
            {detail.next &&
              detail.next.kind !== 'view' &&
              (!detail.action || detail.action.state === 'failed') &&
              detail.status === 'open' &&
              button(detail.next.label, () => act(detail, true))}
            {info(
              'sourceDeadline',
              detail.sourceDeadline
                ? `${detail.sourceDeadline.date} ${detail.sourceDeadline.at ?? ''} · ${detail.sourceDeadline.timeZone}\n${detail.sourceDeadline.quote ?? ''}`
                : undefined,
            )}
            {detail.deadlineOverride &&
              info('override', effectiveTodoDeadline(detail)?.date ?? tr('clearDate'))}
            {detail.deadlineCandidate && (
              <>
                {info('deadlineReason', detail.deadlineCandidate.reason)}
                {button(tr('confirmDate'), () => update(detail, { operation: 'confirm-deadline' }))}
              </>
            )}
            {info('reminder', detail.decision?.until)}
            {!!detail.sources.length && (
              <View style={styles.field}>
                <Text style={styles.caption}>{tr('sources')}</Text>
                {detail.sources.map((s) => (
                  <View key={s.kind + ':' + s.id}>
                    <Text selectable style={styles.body}>
                      {s.label}
                      {s.observedAt ? ' · ' + s.observedAt : ''}
                    </Text>
                    {s.ref && button(tr('view'), () => void Linking.openURL(s.ref!))}
                  </View>
                ))}
              </View>
            )}
            {!!detail.associations.length &&
              info(
                'associations',
                detail.associations.map((a) => a.label).join('\n'),
              )}
            {detail.history.map((h, n) => (
              <View key={n}>
                {info(
                  'evidence',
                  (h.summary === 'Legacy completion evidence was not recorded'
                    ? tr('legacyEvidence')
                    : h.summary) +
                    ' · ' +
                    h.at,
                )}
                {h.ref &&
                  /^https:\/\//.test(h.ref) &&
                  button(tr('evidence'), () => void Linking.openURL(h.ref!))}
              </View>
            ))}
            {button(tr('edit'), () => edit(detail, 'edit'))}
            {button(tr('more'), () => menu(detail))}
          </>
        ) : (
          <>
            <View style={styles.toolbar}>
              <TextInput
                style={[styles.input, styles.flex]}
                value={query}
                onChangeText={(value) => {
                  setQuery(value);
                  setOffset(0);
                }}
                placeholder={tr('search')}
                accessibilityLabel={tr('search')}
              />
              <Pressable
                style={styles.icon}
                accessibilityRole="button"
                accessibilityLabel={tr('new')}
                onPress={() => edit(null, 'edit')}
              >
                <Plus color={colors.textPrimary} size={iconSize.action} />
              </Pressable>
            </View>
            <View style={styles.toolbar}>
              {button(
                tr(filter.view === 'open' ? 'hidden' : 'open'),
                () => {
                  setFilter({
                    ...filter,
                    view: filter.view === 'open' ? 'hidden' : 'open',
                  });
                  setOffset(0);
                },
                styles.flex,
              )}
              {button(
                tr(filter.order === 'created' ? 'createdOrder' : 'dueOrder'),
                () => {
                  setFilter({
                    ...filter,
                    order: filter.order === 'created' ? 'due' : 'created',
                  });
                  setOffset(0);
                },
                styles.flex,
              )}
            </View>
            {loading && (
              <ActivityIndicator accessibilityLabel={tr('loading')} color={colors.textSecondary} />
            )}
            {!loading && !page.items.length && (
              <Text style={styles.body}>{tr(query ? 'noMatch' : 'empty')}</Text>
            )}
            {page.items.map((x) => (
              <CompanionTodoRow
                key={x.id}
                item={x}
                label={label(x)}
                locale={i18n.language}
                busy={busy || !online}
                onOpen={() => {
                  setDetail(x);
                  setEditing(false);
                  setShowActions(false);
                }}
                onAction={() => act(x)}
                onDate={() => edit(x, 'deadline')}
                onMore={() => menu(x)}
                tr={tr}
              />
            ))}
            {page.total > 25 && (
              <View style={styles.toolbar}>
                {button(
                  tr('previous'),
                  () => setOffset(Math.max(0, page.offset - 25)),
                  undefined,
                  !page.offset,
                )}
                <Text style={styles.caption}>
                  {tr('page', {
                    start: page.offset + 1,
                    end: Math.min(page.offset + 25, page.total),
                    count: page.total,
                  })}
                </Text>
                {button(
                  tr('following'),
                  () => setOffset(page.offset + 25),
                  undefined,
                  page.offset + 25 >= page.total,
                )}
              </View>
            )}
            <Pressable
              style={styles.disclosure}
              accessibilityRole="button"
              accessibilityState={{ expanded: filter.view === 'done' }}
              onPress={() => {
                setFilter({
                  ...filter,
                  view: filter.view === 'done' ? 'open' : 'done',
                });
                setOffset(0);
              }}
            >
              {filter.view === 'done' ? (
                <ChevronDown color={colors.textSecondary} size={iconSize.md} />
              ) : (
                <ChevronRight color={colors.textSecondary} size={iconSize.md} />
              )}
              <Text style={styles.caption}>
                {tr('done')} · {page.completedTotal}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </CompanionSheet>
  );
}
