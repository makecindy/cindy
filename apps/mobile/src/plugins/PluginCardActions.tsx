import { ghostCardSessionLinkId } from '@cindy/maker-shared/ghost-card-form';
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { prStatusItemKeys, type PrStatusKind, type PrStatusResult } from "@cindy/maker-shared";
import {
  parseGhostCardForm,
  parseMailCard,
  mailCardStatus,
  mailSendRemainingFraction,
  type MailCardData,
  mergeGhostCardFormValues,
  trackGhostCardFormDelivery,
  releaseGhostCardFormDelivery,
  GHOST_CARD_FORM_MAX_VALUE,
  visibleMailAttachments,
  removeMailAttachment,
  canInsertMailImage,
  insertMailImage,
  mailPreviewImages,
  type GhostCardFormField,
  ghostCardLinkOpensDirectly,
} from "@cindy/maker-shared/ghost-card-form";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  AppState,
  Linking,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  useWindowDimensions,
  View,
  type ViewInstance,
} from "react-native";
import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  type PluginPageConfirm,
  type PluginPagePoll,
  type PluginNativeIntent as NativeIntent,
  type PluginPageFetchResult,
} from "@cindy/device-link";
import { Text, TextInput } from "@/components/AppText";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { useAuth } from "@/auth/AuthContext";
import { MobileMailHtmlPreview } from "./MobileMailHtmlPreview";
import { pickMobileMailAttachment } from "./mobileMailAttachment";
import { PluginCardRecipients } from "./PluginCardRecipients";
import { invokePlugin } from "./pluginClient";
import { PluginNativeIntent } from "./PluginNativeIntent";
import { FileTypeIcon } from '@/components/FileTypeIcon';
import { Check, CircleMinus, CircleX, Clock, ExternalLink, Settings, ChevronDown } from 'lucide-react-native';
import { prStatusVisual } from '@/session/prStatusVisual';
import { MessageListItemViewableContext } from '@/session/messageListVisibility';
import { taskAutoArchive } from './taskAutoArchive';
import { formatByteSize } from '@cindy/maker-shared/file-preview';

interface Action {
  id: string;
  label: string;
  prompt?: string;
  url?: string;
  disabled: boolean;
  submit?: boolean;
  /** Rich hints from hosts that honour `plugin-card-rich`. */
  primary?: boolean;
  toggle?: { on: boolean; title: string; hint?: string };
  /** The linked PR's current state (desktop hosts that know the task's PRs). */
  prState?: PrStatusKind;
}
const PR_STATES: readonly PrStatusKind[] = ["open", "draft", "merged", "closed"];
interface PrStatusSlot { key: string; fallback: string[]; status?: Extract<PrStatusResult, { ok: true }> }
/** The host's word that every PR of the task is merged (the card's archive button); `auto`: archive on leaving. */
interface TaskArchive { auto: boolean }

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** The host sends the title bar's PR status; keep only fields the status row reads. */
function parsePrStatus(value: unknown): PrStatusSlot["status"] {
  const v = value as Record<string, unknown> | null;
  if (!v || v.ok !== true || !["open", "draft", "merged", "closed"].includes(v.status as string)) return undefined;
  const checks = v.checks as Record<string, unknown> | null | undefined;
  const validChecks = checks && ["total", "failed", "passed", "pending", "skipped"].every((k) => isCount(checks[k]));
  const text = (x: unknown) => (typeof x === "string" ? x : null);
  return {
    ok: true, owner: "", repo: "", prNumber: 0, title: "", htmlUrl: "", branch: "",
    status: v.status as "open" | "draft" | "merged" | "closed",
    unresolvedCount: isCount(v.unresolvedCount) ? v.unresolvedCount : null,
    checks: validChecks ? (checks as unknown as NonNullable<Extract<PrStatusResult, { ok: true }>["checks"]>) : null,
    ...("mergeState" in v ? { mergeState: text(v.mergeState) } : {}),
    ...("reviewDecision" in v ? { reviewDecision: text(v.reviewDecision) } : {}),
  };
}
function parsePrStatusSlots(value: unknown): PrStatusSlot[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).flatMap((slot) => {
    const s = slot as Record<string, unknown> | null;
    if (!s || typeof s.key !== "string" || !Array.isArray(s.fallback)) return [];
    const fallback = s.fallback.filter((x): x is string => typeof x === "string" && x.length <= 200).slice(0, 8);
    const status = parsePrStatus(s.status);
    return [{ key: s.key, fallback, ...(status ? { status } : {}) }];
  });
}
function parse(value: unknown): {
  pluginId: string;
  revision: string;
  items: Action[];
  form: GhostCardFormField[] | null;
  changeAction?: string;
  mail?: MailCardData | null;
  legacyMail?: boolean;
  mailUpload?: boolean;
  live?: string;
  prStatus: PrStatusSlot[];
  taskArchive?: TaskArchive;
} | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.pluginId !== "string" ||
    typeof data.revision !== "string" ||
    !Array.isArray(data.items) ||
    data.items.length > 64
  )
    return null;
  const items = data.items.filter(
    (item): item is Action =>
      item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      typeof item.label === "string" &&
      item.label.length <= 2048 &&
      typeof item.disabled === "boolean" &&
      (item.prompt === undefined || typeof item.prompt === "string") &&
      (item.submit === undefined || typeof item.submit === "boolean") &&
      (item.url === undefined || typeof item.url === "string") &&
      (item.primary === undefined || typeof item.primary === "boolean") &&
      (item.prState === undefined || PR_STATES.includes(item.prState)) &&
      (item.toggle === undefined || (typeof item.toggle === "object" && item.toggle !== null &&
        typeof item.toggle.on === "boolean" && typeof item.toggle.title === "string" && item.toggle.title.length <= 200 &&
        (item.toggle.hint === undefined || (typeof item.toggle.hint === "string" && item.toggle.hint.length <= 400)))),
  );
  return {
    mail: parseMailCard(data.mail),
    legacyMail: data.legacyMail === true,
    mailUpload: data.mailUpload === true,
    pluginId: data.pluginId,
    revision: data.revision,
    items,
    form: parseGhostCardForm(data.form),
    changeAction:
      typeof data.changeAction === "string" ? data.changeAction : undefined,
    live: typeof data.live === "string" && data.live.length <= 64 ? data.live : undefined,
    prStatus: parsePrStatusSlots(data.prStatus),
    ...(isTaskArchive(data.taskArchive) ? { taskArchive: { auto: data.taskArchive.auto } } : {}),
  };
}
function isTaskArchive(value: unknown): value is TaskArchive {
  return !!value && typeof value === "object" && typeof (value as { auto?: unknown }).auto === "boolean";
}
export function PluginCardActions({
  data,
  deviceId,
  sessionId,
  callId,
  onOpenAttachment,
  onOpenSessionLink,
  text,
}: {
  data: unknown;
  deviceId?: string;
  sessionId: string;
  callId: string;
  onOpenAttachment?: (url: string, name: string) => void;
  onOpenSessionLink?: (url: string) => void;
  /** The card's projected text; drawn here as the card's title and detail lines. */
  text?: string;
}) {
  const parsed = parse(data);
  return parsed && !parsed.mail?.supersededBy && deviceId ? (
    <CardControls
      key={`${deviceId}:${sessionId}:${callId}:${parsed.pluginId}`}
      {...parsed}
      deviceId={deviceId}
      sessionId={sessionId}
      callId={callId}
      onOpenSessionLink={onOpenSessionLink}
      onOpenAttachment={onOpenAttachment}
      text={text}
    />
  ) : null;
}
function CardControls({
  form,
  changeAction,
  mail,
  legacyMail,
  mailUpload,
  pluginId,
  revision,
  items,
  live,
  prStatus,
  taskArchive,
  deviceId,
  sessionId,
  callId,
  onOpenAttachment,
  onOpenSessionLink,
  text,
}: {
  text?: string;
  live?: string;
  prStatus: PrStatusSlot[];
  taskArchive?: TaskArchive;
  form: GhostCardFormField[] | null;
  changeAction?: string;
  mail?: MailCardData | null;
  legacyMail?: boolean;
  mailUpload?: boolean;
  pluginId: string;
  revision: string;
  items: Action[];
  deviceId: string;
  sessionId: string;
  callId: string;
  onOpenAttachment?: (url: string, name: string) => void;
  onOpenSessionLink?: (url: string) => void;
}) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const history = !!mail?.supersededBy || !!legacyMail;
  // Non-mail cards read like Desktop's: a title (the card's own link when it has one), quiet
  // detail lines, and compact buttons. Mail cards keep their editor layout.
  const compact = !mail && !legacyMail;
  const projectedLines = compact && text ? text.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  // The GitHub card has a stable action vocabulary. Keep its settings controls together
  // instead of mixing them into the footer. Unknown/legacy cards retain the generic layout.
  const hasLegacySettings = items.some(action => ['prset:rename', 'prset:follow', 'prset:archive'].includes(action.id) && !action.toggle);
  const settingsAction = compact && !hasLegacySettings && projectedLines.length > 0 && pluginId === 'cindy-github'
    ? items.find(action => action.id === 'prui:settings') : undefined;
  const settingsOpen = !!settingsAction && items.some(action => action.toggle);
  const modelChoices = settingsOpen ? items.filter(action => ['prset:modelTask', 'prset:model'].includes(action.id)) : [];
  const modelPicker = settingsOpen ? items.find(action => action.id === 'prset:modelPick') : undefined;
  // Rich projection removes control text but retains the panel heading and model description,
  // in document order after the PR summary. Keep the host's language, including older hosts.
  const settingsLineCount = settingsOpen ? 1 + (modelChoices.length === 2 ? (modelPicker ? 1 : 2) : 0) : 0;
  const settingsLines = settingsLineCount && projectedLines.length > settingsLineCount
    ? projectedLines.slice(-settingsLineCount) : [];
  const lines = settingsLines.length ? projectedLines.slice(0, -settingsLineCount) : projectedLines;
  const titleLink = lines.length ? items.find((action) => action.url && !action.disabled && action.label === lines[0]) : undefined;
  const titleHost = titleLink?.url ? linkHost(titleLink.url) : undefined;
  // A PR link leads with the app's own PR icon in its status colour (as on the home task row);
  // other links end with a quiet external-link mark.
  const titlePr = titleLink?.url && /^https:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(titleLink.url)
    ? prStatusVisual(titleLink.prState ?? prStatus.find((slot) => slot.key === githubPrKeyOfUrl(titleLink.url!))?.status?.status ?? null, colors) : undefined;
  const buttons = (history ? [] : items).filter((action) => !action.toggle && action !== titleLink && action !== settingsAction && !modelChoices.includes(action) && action !== modelPicker);
  const { getAccessToken } = useAuth();
  const readonly = history || ['sent', 'sending', 'unconfirmed', 'deleting', 'deleted'].includes(mail?.state ?? '');
  const [countdownNow, setCountdownNow] = useState(Date.now);
  useEffect(() => {
    if (!mail?.pendingSend) return;
    setCountdownNow(Date.now());
    const timer = setInterval(() => setCountdownNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [mail?.pendingSend?.deadline]);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const { invoke, status } = useDeviceLink();
  const focused = useIsFocused(),
    focusedRef = useRef(focused);
  focusedRef.current = focused;
  const lifetime = useRef({ active: true, owner: getMobileAuthOwner() });
  const sending = useRef(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const mailEditable = useRef(!readonly); mailEditable.current = !readonly;
  useEffect(() => { if (readonly) uploadAbort.current?.abort(); }, [readonly]);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const page = useRef<string | undefined>(undefined);
  const [lease, setLease] = useState<string>();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  // Archive button and auto-archive (desktop's card rule): this card arms auto-archive while the host says its PR and the
  // task's other PRs are merged and the plugin asked for it. Unmounting does not disarm: leaving the task unmounts cards,
  // which is exactly when the task page archives.
  const autoArchive = !history && !!taskArchive?.auto;
  // undefined: nothing reported yet. Every mount reports once, even `false`, so a cancellation kept from an earlier visit
  // is forgotten when the host no longer allows auto-archive.
  const armedRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (armedRef.current === autoArchive) return;
    armedRef.current = autoArchive;
    taskAutoArchive.setArmed(sessionId, callId, autoArchive);
  }, [sessionId, callId, autoArchive]);
  const autoArchiveState = useSyncExternalStore(
    taskAutoArchive.onChange,
    () => taskAutoArchive.getState(sessionId),
  );
  // "Seen": this armed card was on screen in the focused task page with the app in front, not merely mounted.
  // The message row is only the first gate (a row can hold several cards and passes at 5%): the notice itself must be
  // inside the window. A frame that cannot be measured does not count, and neither does one that scrolled into view later
  // inside a tall row (no event reports it); both only mean no auto-archive, never an archive nobody saw.
  const viewable = useContext(MessageListItemViewableContext) ?? true;
  const { height: windowHeight } = useWindowDimensions();
  const noticeRef = useRef<ViewInstance>(null);
  const seenGate = useRef({ pending: false, viewable, focused, foreground });
  seenGate.current = { pending: autoArchive && autoArchiveState === "pending", viewable, focused, foreground };
  const checkNoticeSeen = useCallback(() => {
    const gate = seenGate.current;
    if (!gate.pending || !gate.viewable || !gate.focused || !gate.foreground) return;
    noticeRef.current?.measureInWindow((_x, y, _width, height) => {
      if (Number.isFinite(y) && height > 0 && y + height > 0 && y < windowHeight) taskAutoArchive.markSeen(sessionId);
    });
  }, [sessionId, windowHeight]);
  useEffect(checkNoticeSeen, [checkNoticeSeen, autoArchive, autoArchiveState, viewable, focused, foreground]);
  const archiveHint = autoArchive && autoArchiveState !== "inactive" ? autoArchiveState : undefined;
  const [prompt, setPrompt] = useState<Action>();
  const [draft, setDraft] = useState("");
  const formKey = changeAction ?? JSON.stringify(form);
  const formRetired = history || ['sent', 'deleted'].includes(mail?.state ?? '');
  useEffect(() => () => releaseGhostCardFormDelivery(JSON.stringify([deviceId, sessionId]), callId),
    [deviceId, sessionId, callId, formKey, formRetired]);
  const changeQueue = useRef(Promise.resolve(true));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const incoming = Object.fromEntries(
    (form ?? []).map((field) => [field.name, field.value]),
  );
  const [formState, setFormState] = useState(() => ({
    key: formKey,
    values: incoming,
    base: incoming,
  }));
  const formValues =
    formState.key === formKey
      ? mergeGhostCardFormValues(formState.values, formState.base, incoming)
      : incoming;
  const latestValues = useRef(formValues); latestValues.current = formValues;
  if (
    formState.key !== formKey ||
    JSON.stringify(formState.base) !== JSON.stringify(incoming)
  ) {
    setFormState({ key: formKey, values: formValues, base: incoming });
  }
  const [confirm, setConfirm] = useState<PluginPageConfirm>();
  const [previewIntent, setPreviewIntent] = useState<Extract<NativeIntent, { kind: 'preview' }>>();
  const dismissedPreviews = useRef(new Set<string>());
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [answering, setAnswering] = useState(false);
  const current = () =>
    lifetime.current.active && isMobileAuthOwnerCurrent(lifetime.current.owner);
  useEffect(() => {
    sending.current = false;
    setBusy(false);
    setUnknown(false);
  }, [revision]);
  useEffect(() => {
    const token = { active: true, owner: getMobileAuthOwner() };
    lifetime.current = token;
    const listener = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      setConfirm(undefined);
    });
    return () => {
      token.active = false;
      uploadAbort.current?.abort();
      listener.remove();
      if (page.current && isMobileAuthOwnerCurrent(lifetime.current.owner))
        void invokePlugin(invoke, deviceId, pluginId, "close", {
          pageId: page.current,
        }).catch(() => {});
    };
  }, [invoke, deviceId, pluginId]);
  useEffect(() => {
    if (!lease) return;
    if (!focused || !foreground || status !== "online") {
      // The host discards preview resources on suspend. Resume only from a fresh receipt.
      setPreviewIntent(undefined);
      if (current() && status === "online")
        void invokePlugin(invoke, deviceId, pluginId, "suspend", {
          pageId: lease,
        }).catch(() => {});
      return;
    }
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (disposed || !current()) return;
      try {
        const result = await invokePlugin<PluginPagePoll>(
          invoke,
          deviceId,
          pluginId,
          "poll",
          { pageId: lease, after: 0 },
        );
        if (!disposed && current()) {
          setConfirm(result.confirms[0]);
          setPreviewIntent(result.intents?.find(
            (intent): intent is Extract<NativeIntent, { kind: 'preview' }> =>
              intent.kind === 'preview' && !dismissedPreviews.current.has(intent.id),
          ));
        }
      } catch {
        if (!disposed && current()) {
          setUnknown(true);
          setConfirm(undefined);
        }
      }
      if (!disposed && current()) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [lease, focused, foreground, status, invoke, deviceId, pluginId]);
  const submit = async (
    action: Action,
    text?: string,
    edits?: Record<string, string>,
    mailAttachment?: { url: string; name: string },
  ) => {
    const passive = edits !== undefined;
    if (
      (!passive && sending.current) ||
      (!passive && busy) ||
      (!passive && unknown) ||
      action.disabled || (readonly && !(!history && mail && (
        (mail.state === 'sent' && action.id === `mail:continue:${mail.key}`) ||
        (mail.pendingSend && [`mail:cancel:${mail.key}`, `mail:now:${mail.key}`].includes(action.id))
      ))) ||
      (action.submit && !form) ||
      status !== "online" ||
      !focusedRef.current ||
      AppState.currentState !== "active"
    )
      return false;
    const token = lifetime.current,
      expectedRevision = revision;
    const valid = () =>
      token.active &&
      lifetime.current === token &&
      isMobileAuthOwnerCurrent(token.owner);
    if (!passive) {
      sending.current = true;
      setBusy(true);
    }
    try {
      if (!passive && action.submit && !(await changeQueue.current))
        throw new Error("CARD_FORM_SYNC_FAILED");
      if (!page.current) {
        const opened = await invokePlugin<{ pageId: string }>(
          invoke,
          deviceId,
          pluginId,
          "open-interaction",
        );
        if (!valid()) {
          if (isMobileAuthOwnerCurrent(token.owner))
            void invokePlugin(
              invoke,
              deviceId,
              pluginId,
              "close",
              opened,
            ).catch(() => {});
          return false;
        }
        page.current = opened.pageId;
        setLease(opened.pageId);
      }
      await invoke(
        deviceId,
        REMOTE_RESOURCE_INVOKE_CHANNEL,
        [
          {
            client: {
              protocolVersion: 1,
              primitives: ["plugin-card-actions", "plugin-card-forms"],
            },
            collectionId: "plugin-results",
            resourceRef: {
              collectionId: "plugin-results",
              kind: "card",
              id: JSON.stringify([sessionId, callId]),
            },
            actionId: action.id,
            input: {
              revision,
              pageId: page.current,
              ...(text !== undefined ? { prompt: text } : {}),
              ...(action.submit ? { formValues: edits ?? latestValues.current } : {}),
              ...(mailAttachment ? { mailAttachment } : {}),
              ...(passive ? { formChange: true } : {}),
              ...(changeAction ? { formKey: changeAction } : {}),
            },
          },
        ],
        {
          preSend: () => {
            if (
              !valid() ||
              (mailAttachment && !mailEditable.current) ||
              !focusedRef.current ||
              AppState.currentState !== "active" ||
              (!passive &&
                !changeAction &&
                revisionRef.current !== expectedRevision)
            )
              throw new Error("PLUGIN_PAGE_CLOSED");
          },
        },
      );
      if (valid() && revisionRef.current === expectedRevision) {
        setPrompt(undefined);
        setDraft("");
        if (!action.submit) {
          sending.current = false;
          setBusy(false);
        }
      }
      if (passive && valid()) setUnknown(false);
      return true;
      // A known delivery permits a new deliberate click, never an automatic replay.
    } catch {
      if (valid()) {
        setUnknown(true);
        if (!passive) {
          setBusy(false);
          sending.current = false;
        }
      }
      return false;
    }
  };
  const choose = (action: Action) => {
    if (action.url) {
      if (ghostCardSessionLinkId(action.url)) {
        onOpenSessionLink?.(action.url);
        return;
      }
      let url: URL;
      try {
        url = new URL(action.url);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (ghostCardLinkOpensDirectly(url.href)) {
        void Linking.openURL(url.href).catch(() => setUnknown(true));
        return;
      }
      Alert.alert(t("plugins.externalTitle"), url.href, [
        { text: t("plugins.cancel"), style: "cancel" },
        {
          text: t("plugins.open"),
          onPress: () => {
            void Linking.openURL(url.href).catch(() => setUnknown(true));
          },
        },
      ]);
    } else if (action.prompt !== undefined) {
      setPrompt(action);
      setDraft("");
    } else void submit(action);
  };
  const answer = async (confirmed: boolean) => {
    if (!confirm || answering) return;
    setAnswering(true);
    try {
      await invokePlugin(invoke, deviceId, pluginId, "answer", {
        pageId: page.current,
        confirmId: confirm.id,
        confirmed,
      });
      if (current()) setConfirm(undefined);
    } catch {
      if (current()) {
        setUnknown(true);
        setConfirm(undefined);
      }
    } finally {
      if (current()) setAnswering(false);
    }
  };
  const changeField = (name: string, value: string, related?: Record<string, string>) => {
    if (readonly) return;
    const values = { ...formValues, ...related, [name]: value };
    setFormState({ key: formKey, values, base: incoming });
    if (changeAction) {
      changeQueue.current = changeQueue.current.then(() =>
        submit(
          {
            id: changeAction,
            label: "",
            disabled: false,
            submit: true,
          },
          undefined,
          values,
        ),
      );
      trackGhostCardFormDelivery(
        JSON.stringify([deviceId, sessionId]),
        callId,
        changeQueue.current,
      );
    }
  };
  const attach = async () => {
    if (!mail || readonly || busy || unknown || uploadAbort.current || status !== 'online') return;
    const controller = new AbortController(); uploadAbort.current = controller;
    setUploading(true); setUploadError('');
    const isActive = () => current() && !controller.signal.aborted && mailEditable.current;
    try {
      await pickMobileMailAttachment({ deviceId, getAccessToken, signal: controller.signal, isActive,
        deliver: file => isActive() ? submit({ id: `mail:attach:${mail.key}`, label: '', disabled: false, submit: true }, undefined, undefined, file) : Promise.resolve(false) });
    } catch (error) {
      if (isActive()) setUploadError(error instanceof Error && error.message === t('plugins.mailAttachTooLarge') ? error.message : t('plugins.mailAttachFailed'));
    } finally {
      if (uploadAbort.current === controller) uploadAbort.current = null;
      if (current()) setUploading(false);
    }
  };
  if (mail?.state === 'deleted') {
    const subject = mail.fields.find(f => f.name === 'subject')?.value;
    return <View style={[styles.mailCard, styles.deletedMail]} accessibilityLiveRegion="polite">
      <Text style={styles.note}>{mailCardStatus(mail)}</Text>
      {subject ? <Text numberOfLines={1} style={[styles.note, styles.deletedSubject]}>· {subject}</Text> : null}
    </View>;
  }
  return (
    <View style={[styles.root, mail && !history && styles.mailCard]}>
      {previewIntent && lease && focused && foreground && status === 'online' && current() ? (
        <PluginNativeIntent
          key={previewIntent.id}
          intent={previewIntent}
          deviceId={deviceId}
          onClose={() => {
            const token = lifetime.current;
            const intentId = previewIntent.id;
            dismissedPreviews.current.add(intentId);
            setPreviewIntent(undefined);
            void invokePlugin(invoke, deviceId, pluginId, 'intent:ack', { pageId: lease, intentId })
              .catch(() => { if (lifetime.current === token && current()) setUnknown(true); });
          }}
          readPreview={(url, offset, revision) => {
            if (!current() || !focusedRef.current || AppState.currentState !== 'active')
              return Promise.reject(new Error('PLUGIN_PAGE_CLOSED'));
            return invokePlugin<PluginPageFetchResult>(invoke, deviceId, pluginId, 'preview:fetch', {
              pageId: lease, intentId: previewIntent.id, url, offset,
              ...(revision ? { revision } : {}),
            });
          }}
          readMedia={() => Promise.reject(new Error('PLUGIN_PAGE_CLOSED'))}
        />
      ) : null}
      {lines.length ? (
        <View style={styles.headerRow}>
        <View style={[styles.cardHeader, styles.headerContent]}>
          {titleLink && titleHost ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`${lines[0]}: ${t("plugins.openLinkHost", { host: titleHost })}`}
              hitSlop={{ top: spacing.xs, bottom: spacing.xs }}
              onPress={() => choose(titleLink)}
              style={({ pressed }) => [styles.titleRow, pressed && styles.pressed]}
            >
              {titlePr ? <titlePr.Icon size={iconSize.md} strokeWidth={iconStroke.regular} color={titlePr.color} style={styles.titleMark} /> : null}
              <Text style={[styles.cardTitle, styles.titleText]}>{lines[0]}</Text>
              {!titlePr ? (
                <ExternalLink size={iconSize.sm} strokeWidth={iconStroke.thin} color={colors.textTertiary} style={styles.titleIcon} />
              ) : null}
            </Pressable>
          ) : (
            <Text selectable style={styles.cardTitle}>{lines[0]}</Text>
          )}
          {lines.slice(1).map((line, index) => (
            <Text key={index} selectable style={styles.note}>{line}</Text>
          ))}
        </View>
        {settingsAction ? <Pressable
          accessibilityRole="button"
          accessibilityLabel={settingsAction.label}
          accessibilityState={{ expanded: settingsOpen }}
          disabled={settingsAction.disabled || busy || unknown || status !== "online"}
          onPress={() => choose(settingsAction)}
          hitSlop={6}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          {settingsOpen ? <View pointerEvents="none" style={styles.settingsButtonActive} /> : null}
          <Settings size={iconSize.md} strokeWidth={iconStroke.regular} color={settingsOpen ? colors.textPrimary : colors.textTertiary} />
        </Pressable> : null}
        </View>
      ) : null}
      {history ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: historyExpanded }} onPress={() => setHistoryExpanded(!historyExpanded)}>
        <Text style={styles.note}>{historyExpanded ? '▾ ' : '▸ '}{t(legacyMail ? 'plugins.mailLegacy' : 'plugins.mailUpdated')}{' · '}{form?.find(f => f.name === 'subject')?.value}</Text>
      </Pressable> : null}
      {history && historyExpanded ? <View style={styles.root}>{form?.filter(f => f.value && f.kind !== 'hidden' && (f.kind !== 'mail-attachments' || visibleMailAttachments(formValues, f.name).length)).map(field =>
        <View key={field.name}><Text style={styles.note}>{field.label}</Text>
          {field.kind === 'mail-html' ? <MobileMailHtmlPreview html={field.value} images={mailPreviewImages(formValues, mail?.images)} deviceId={deviceId} /> :
            <Text style={styles.body}>{field.kind === 'mail-attachments' ? visibleMailAttachments(formValues, field.name).map(file => file.filename).join(' · ') : field.value}</Text>}
        </View>
      )}</View> : null}
      {!history && form?.length ? <View style={styles.form}>
        {form?.map((field) => {
          if (field.kind === 'hidden') return null;
          if (field.kind === 'mail-html') return <MobileMailHtmlPreview key={field.name} html={formValues[field.name]} images={mailPreviewImages(formValues, mail?.images)} deviceId={deviceId}
            disabled={busy || uploading || unknown || status !== 'online'}
            onChange={readonly ? undefined : (html, text) => {
              const plain = field.name === 'quoteHtml' ? 'quote' : 'body';
              changeField(field.name, html, plain in formValues ? { [plain]: text } : undefined);
            }} />;
          if (field.kind === 'mail-attachments') {
            const files = visibleMailAttachments(formValues, field.name);
            if (!files.length && (readonly || !mailUpload) && !uploadError) return null;
            return <View key={field.name} style={styles.fullField}>
            {mailUpload && !readonly && <Pressable accessibilityRole="button" disabled={busy || uploading || unknown || status !== 'online'} style={styles.attachButton} onPress={() => void attach()}><Text style={styles.note}>{uploading ? t('plugins.mailAttaching') : t('plugins.mailAttach')}</Text></Pressable>}
            {files.map(file => <View key={file.key} style={styles.attachment}>
              <Pressable accessibilityRole="button" accessibilityLabel={file.filename} disabled={!file.previewUrl || !onOpenAttachment} style={styles.attachmentOpen} onPress={() => file.previewUrl && onOpenAttachment?.(file.previewUrl, file.filename)}>
                <FileTypeIcon name={file.filename} mimeType={file.mimeType} />
                <View style={styles.attachmentText}><Text numberOfLines={1} style={styles.note}>{file.filename}</Text><Text style={styles.note}>{file.filename.split('.').pop()?.toUpperCase()}{file.bytes !== undefined ? ' · ' + formatByteSize(file.bytes) : ''}</Text></View>
              </Pressable>
              {!readonly && canInsertMailImage(formValues, file) && <Pressable accessibilityRole="button" disabled={busy || uploading || unknown || status !== 'online'} style={styles.attachButton} onPress={() => {
                const next = insertMailImage(formValues, field.name, file.key);
                changeField(field.name, next[field.name], next);
              }}><Text style={styles.note}>{t('plugins.mailInsertImage')}</Text></Pressable>}
              {!readonly && <Pressable accessibilityRole="button" disabled={busy || uploading} style={styles.attachButton} accessibilityLabel={t('plugins.mailRemoveAttachment', { name: file.filename })} onPress={() => {
                const next = removeMailAttachment(formValues, field.name, file.key);
                changeField(field.name, next[field.name], next);
              }}><Text style={styles.note}>×</Text></Pressable>}
            </View>)}
            {uploadError ? <Text style={styles.note}>{uploadError}</Text> : null}
          </View>;
          }
          if (field.kind === "recipients") {
            const group = form.filter(
              (f) => f.kind === "recipients" && (!['sent', 'deleted'].includes(mail?.state ?? '') || formValues[f.name]?.trim()),
            );
            if (group[0] !== field) return null;
            return (
              <PluginCardRecipients
                key={field.name}
                fields={group.map((f) => ({ ...f, value: formValues[f.name] }))}
                disabled={busy || uploading || readonly}
                readOnly={['sent', 'deleted'].includes(mail?.state ?? '')}
                onChange={changeField}
              />
            );
          }
          return (
            <View
              key={field.name}
              style={[
                styles.root,
                styles.fullField,
                !field.multiline && !field.collapsed && styles.inlineField,
              ]}
            >
              {field.collapsed ? (
                <Pressable
                  onPress={() =>
                    setExpanded({
                      ...expanded,
                      [field.name]: !expanded[field.name],
                    })
                  }
                >
                  <Text style={styles.note}>
                    {expanded[field.name] ? "▾ " : "▸ "}
                    {field.label}
                  </Text>
                </Pressable>
              ) : !field.multiline ? (
                <Text style={styles.note}>{field.label}</Text>
              ) : null}
              {(!field.collapsed || expanded[field.name]) && (
                <TextInput
                  accessibilityLabel={field.label}
                  value={formValues[field.name]}
                  multiline={field.multiline}
                  editable={!busy && !uploading && !readonly}
                  maxLength={GHOST_CARD_FORM_MAX_VALUE}
                  onChangeText={(value) => changeField(field.name, value)}
                  style={[
                    styles.formInput,
                    field.multiline && styles.multiline,
                  ]}
                />
              )}
            </View>
          );
        })}
      </View> : null}
      {(mail && !history) || prStatus.length || buttons.length || live || taskArchive || items.some((action) => action.toggle) ? <View style={mail && !history ? styles.mailFooter : compact ? styles.compactFooter : undefined}>
        {mail && !history ? (
          <View style={styles.mailInfo}>
            <Text style={styles.note}>{mail.fromLabel}: {mail.from}</Text>
            {mail.attachments.length && !form?.some(f => f.kind === 'mail-attachments') ? (
              <Text style={styles.note}>{mail.attachments.join(' · ')}</Text>
            ) : null}
            <Text style={styles.note}>{mailCardStatus(mail, countdownNow)}</Text>
          </View>
        ) : null}
        {prStatus.map((slot) => <PrStatusRow key={slot.key} slot={slot} />)}
        {items.some(action => action.toggle) || modelChoices.length ? <View style={settingsOpen ? styles.settingsPanel : styles.root}>
        {settingsLines[0] ? <Text style={styles.sectionLabel}>{settingsLines[0]}</Text> : null}
        {(history ? [] : items).filter((action) => action.toggle).map((action) => (
          <View key={action.id} style={[styles.toggleRow, settingsOpen && styles.settingRow]}>
            <View style={styles.toggleText}>
              <Text style={styles.label}>{action.toggle!.title}</Text>
              {action.toggle!.hint ? <Text style={styles.note}>{action.toggle!.hint}</Text> : null}
            </View>
            <Switch
              accessibilityLabel={action.toggle!.title}
              value={action.toggle!.on}
              disabled={action.disabled || busy || unknown || status !== "online"}
              onValueChange={() => choose(action)}
            />
          </View>
        ))}
        {modelChoices.length ? <View style={styles.modelSection}>
          {settingsLines[1] ? <Text style={styles.settingLabel}>{settingsLines[1]}</Text> : null}
          {settingsLines[2] ? <Text style={styles.note}>{settingsLines[2]}</Text> : null}
          <View style={styles.modelChoices}>
            {modelChoices.map(action => {
              const selected = action.id === (modelPicker ? 'prset:model' : 'prset:modelTask');
              return <Pressable key={action.id} accessibilityRole="radio"
                accessibilityLabel={action.label} accessibilityState={{ checked: selected }}
                disabled={action.disabled || busy || unknown || status !== 'online'}
                onPress={() => choose(action)}
                style={({ pressed }) => [styles.modelChoice, selected && styles.modelChoiceSelected, pressed && styles.pressed]}>
                <Text style={[styles.settingLabel, !selected && styles.quietLabel]}>{action.label}</Text>
              </Pressable>;
            })}
          </View>
          {modelPicker ? <Pressable accessibilityRole="button" accessibilityLabel={modelPicker.label}
            disabled={modelPicker.disabled || busy || unknown || status !== 'online'}
            onPress={() => choose(modelPicker)}
            style={({ pressed }) => [styles.modelPicker, pressed && styles.pressed]}>
            <Text style={[styles.settingLabel, styles.headerContent]}>{modelPicker.label}</Text>
            <ChevronDown size={iconSize.sm} strokeWidth={iconStroke.regular} color={colors.textSecondary} />
          </Pressable> : null}
        </View> : null}
        </View> : null}
        {archiveHint ? <View ref={noticeRef} onLayout={checkNoticeSeen} style={styles.archiveHint} accessibilityLiveRegion="polite">
          <Text style={styles.note}>{t(archiveHint === "pending" ? "plugins.taskArchive.pending" : "plugins.taskArchive.cancelled")}</Text>
          {archiveHint === "pending" ? <Pressable accessibilityRole="button" accessibilityLabel={t("plugins.taskArchive.cancel")}
            hitSlop={{ top: spacing.xs, bottom: spacing.xs }}
            style={({ pressed }) => [styles.button, styles.compactButton, pressed && styles.pressed]}
            onPress={() => taskAutoArchive.cancel(sessionId)}>
            <Text style={[styles.label, styles.compactLabel]}>{t("plugins.taskArchive.cancel")}</Text>
          </Pressable> : null}
        </View> : null}
        {buttons.length || live || (taskArchive && !history) ? <View style={[styles.actions, compact && styles.compactActions]}>
          {buttons.map((action) => {
            const sendNow = !!mail?.pendingSend && action.id === `mail:now:${mail.key}`;
            const primary = action.primary || (!!mail && action.id === `mail:send:${mail.key}`);
            const host = action.url && !ghostCardSessionLinkId(action.url) ? linkHost(action.url) : undefined;
            const label = host ? t("plugins.openLinkHost", { host }) : action.label;
            return (
              <Pressable
                key={action.id}
                accessibilityRole={action.url ? "link" : "button"}
                accessibilityLabel={sendNow && mail ? `${action.label}, ${mailCardStatus(mail, countdownNow)}` : host ? `${label}: ${action.label}` : action.label}
                disabled={action.disabled || busy || uploading || unknown || status !== "online" || (readonly && !mail?.pendingSend && !action.id.startsWith('mail:continue:'))}
                hitSlop={compact ? { top: spacing.xs, bottom: spacing.xs } : undefined}
                style={[styles.button, compact && styles.compactButton, primary && styles.sendButton, sendNow && styles.sendNowButton, host && styles.quietButton]}
                onPress={() => choose(action)}
              >
                {sendNow && mail ? (
                  <View pointerEvents="none" accessible={false} style={StyleSheet.absoluteFill}>
                    <View style={[styles.countdownFill, { width: `${(1 - mailSendRemainingFraction(mail, countdownNow)) * 100}%` }]} />
                  </View>
                ) : null}
                <Text style={[styles.label, compact && styles.compactLabel, primary && styles.sendLabel, host && styles.quietLabel]}>{label}</Text>
              </Pressable>
            );
          })}
          {taskArchive && !history ? <Pressable accessibilityRole="button" accessibilityLabel={t("plugins.taskArchive.now")}
            disabled={status !== "online"}
            hitSlop={compact ? { top: spacing.xs, bottom: spacing.xs } : undefined}
            style={({ pressed }) => [styles.button, compact && styles.compactButton, pressed && styles.pressed]}
            onPress={() => taskAutoArchive.requestArchive(sessionId)}>
            <Text style={[styles.label, compact && styles.compactLabel]}>{t("plugins.taskArchive.now")}</Text>
          </Pressable> : null}
          {live ? <View style={compact && styles.liveEnd}><LiveStatus label={live} /></View> : null}
        </View> : null}
      </View> : null}
      {unknown ? (
        <Text style={styles.note}>{t("plugins.pageUnconfirmed")}</Text>
      ) : null}
      <Modal
        visible={Boolean(focused && foreground && (prompt || confirm))}
        transparent
        onRequestClose={() => {
          if (confirm) void answer(false);
          else setPrompt(undefined);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.scrim}
        >
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.title}>{confirm?.title ?? prompt?.label}</Text>
            {confirm ? (
              <Text style={styles.body}>{confirm.body}</Text>
            ) : (
              <TextInput
                autoFocus
                multiline
                value={draft}
                onChangeText={setDraft}
                maxLength={2000}
                placeholder={prompt?.prompt}
                style={styles.input}
              />
            )}
            <View style={styles.actions}>
              <Pressable
                style={styles.button}
                disabled={answering}
                onPress={() => {
                  if (confirm) void answer(false);
                  else setPrompt(undefined);
                }}
              >
                <Text style={styles.label}>
                  {confirm?.cancelText ?? t("plugins.cancel")}
                </Text>
              </Pressable>
              <Pressable
                style={styles.button}
                disabled={
                  answering || (!confirm && (!draft.trim() || busy || unknown))
                }
                onPress={() => {
                  if (confirm) void answer(true);
                  else if (prompt) void submit(prompt, draft.trim());
                }}
              >
                <Text style={[styles.label, confirm?.danger && styles.danger]}>
                  {confirm?.confirmText ?? t("plugins.confirm")}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
/** `owner/repo#N` (lower-case) of a GitHub pull request URL, the key the Host's PR status slots use. */
function githubPrKeyOfUrl(url: string): string | undefined {
  const m = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}#${Number(m[3])}` : undefined;
}
/** A plugin link reads as "open github.com" instead of repeating the card's title. */
function linkHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.host.replace(/^www\./, "") : undefined;
  } catch {
    return undefined;
  }
}

/** PR checks from the title bar's status (desktop host); the plugin's snapshot otherwise. */
/** Check counts read like the desktop title bar's PR summary: same categories, icons and colours. */
const CHECK_ICONS = { checksFailed: CircleX, checksPending: Clock, checksPassed: Check, checksSkipped: CircleMinus } as const;

function PrStatusRow({ slot }: { slot: PrStatusSlot }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  if (!slot.status) {
    if (!slot.fallback.length) return null;
    return (
      <View style={styles.statusRow}>
        {slot.fallback.map((label, index) => (
          <View key={`${index}:${label}`} style={styles.statusItem}>
            <View style={[styles.statusDot, styles.dotWait]} />
            <Text style={styles.note}>{label}</Text>
          </View>
        ))}
      </View>
    );
  }
  const items = prStatusItemKeys(slot.status);
  if (!items.length) return null;
  return (
    <View style={styles.statusRow}>
      {items.map(({ tone, key, count }) => {
        if (key in CHECK_ICONS) {
          const Icon = CHECK_ICONS[key as keyof typeof CHECK_ICONS];
          const failed = key === "checksFailed";
          return (
            <View key={key} style={styles.statusItem}>
              <Icon size={iconSize.xs} strokeWidth={iconStroke.regular}
                color={failed ? colors.statusError : key === "checksPassed" ? colors.statusDone : colors.textSecondary} />
              <Text style={styles.note}>
                <Text style={styles.statusCount}>{count}</Text> {t(`plugins.prStatus.${key}`)}
              </Text>
            </View>
          );
        }
        const color = key === "threadsOpen" ? styles.statusAccentText : tone === "bad" ? styles.statusBadText
          : key === "mergeReady" || key === "merged" ? styles.statusGoodText : undefined;
        return (
          <Text key={key} style={[styles.note, color]}>
            {t(`plugins.prStatus.${key}`, count === undefined ? undefined : { count })}
          </Text>
        );
      })}
    </View>
  );
}

/** A long-running state (e.g. following a PR) with a breathing dot; still when motion is reduced. */
function LiveStatus({ label }: { label: string }) {
  const styles = useThemedStyles(makeStyles);
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;
      loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1800, useNativeDriver: true }));
      loop.start();
    });
    return () => { cancelled = true; loop?.stop(); };
  }, [pulse]);
  return (
    <View style={styles.liveStatus} accessibilityRole="text" accessibilityLabel={label}>
      <View style={styles.liveDotWrap}>
        <Animated.View style={[styles.liveDot, styles.dotGood, {
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
        }]} />
        <View style={[styles.liveDot, styles.dotGood]} />
      </View>
      <Text style={styles.note}>{label}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { gap: spacing.sm },
    mailCard: { borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: radius.container, padding: spacing.md, backgroundColor: c.surfaceElevated },
    deletedMail: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
    deletedSubject: { flex: 1, minWidth: 0 },
    attachButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm },
    attachment: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: radius.container, marginBottom: spacing.xs },
    attachmentOpen: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, minHeight: 44, flex: 1, minWidth: 0 },
    attachmentText: { flex: 1, minWidth: 0 },
    mailFooter: {
      gap: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingVertical: spacing.sm,
    },
    mailInfo: { minWidth: 0, gap: 0 },
    form: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    inlineField: {
      flexDirection: "row",
      alignItems: "center",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
    },
    fullField: { width: "100%" },
    formInput: {
      color: c.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
      padding: spacing.xs,
      flex: 1,
      minWidth: 0,
      minHeight: 36,
      borderRadius: radius.pill,
    },
    multiline: {
      minHeight: 140,
      width: "100%",
      flex: 0,
      borderRadius: radius.control,
      textAlignVertical: "top",
    },
    actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: 'flex-end', gap: spacing.sm },
    compactActions: { justifyContent: "flex-start", alignItems: "center" },
    compactButton: { minHeight: 36, paddingVertical: 0, paddingHorizontal: spacing.md },
    compactLabel: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
    liveEnd: { marginLeft: "auto" },
    archiveHint: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: spacing.sm, rowGap: spacing.xs },
    compactFooter: { gap: spacing.xs },
    headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    headerContent: { flex: 1, minWidth: 0 },
    cardHeader: { gap: spacing.xs },
    // Match Desktop's 32px gear frame; hitSlop keeps a 44px touch target.
    settingsButton: { width: 32, height: 32, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    settingsButtonActive: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: radius.pill, backgroundColor: c.textPrimary, opacity: 0.07 },
    settingsPanel: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border, marginTop: spacing.sm, paddingTop: spacing.md },
    sectionLabel: { color: c.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, marginBottom: spacing.xs },
    settingRow: { paddingVertical: spacing.md, alignItems: 'flex-start', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    settingLabel: { color: c.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
    modelSection: { gap: spacing.sm, paddingTop: spacing.md },
    modelChoices: { flexDirection: 'row', padding: spacing.xs, gap: spacing.xs, backgroundColor: c.surfaceChip, borderRadius: radius.pill },
    modelChoice: { flex: 1, minWidth: 0, minHeight: 44, padding: spacing.sm, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
    modelChoiceSelected: { backgroundColor: c.surfaceElevated },
    modelPicker: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, padding: spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderRadius: radius.pill },
    cardTitle: { color: c.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold },
    titleRow: { flexDirection: "row", alignItems: "flex-start", alignSelf: "flex-start", maxWidth: "100%", gap: 6 },
    titleText: { flexShrink: 1 },
    // Marks are centred on the title's first line.
    titleMark: { marginTop: (lineHeight.body - iconSize.md) / 2 },
    titleIcon: { marginTop: (lineHeight.body - iconSize.sm) / 2 },
    pressed: { opacity: 0.72 },
    sendButton: { backgroundColor: c.cta },
    quietButton: { backgroundColor: "transparent", paddingHorizontal: spacing.sm },
    quietLabel: { color: c.textSecondary },
    toggleRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 44 },
    toggleText: { flex: 1, minWidth: 0 },
    statusRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: spacing.md, rowGap: spacing.xs },
    statusItem: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
    statusDot: { width: 7, height: 7, borderRadius: radius.pill },
    statusGoodText: { color: c.statusDone },
    statusBadText: { color: c.errorText },
    statusAccentText: { color: c.statusAccent },
    statusCount: { fontWeight: fontWeight.medium, fontVariant: ["tabular-nums"] },
    dotGood: { backgroundColor: c.statusDone },
    dotBad: { backgroundColor: c.statusError },
    dotWait: { borderWidth: 1.5, borderColor: c.textTertiary },
    liveStatus: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.xs },
    liveDotWrap: { width: 7, height: 7 },
    liveDot: { position: "absolute", width: 7, height: 7, borderRadius: radius.pill },
    sendLabel: { color: c.ctaText },
    countdownFill: { height: "100%", backgroundColor: c.textPrimary, opacity: 0.14 },
    sendNowButton: { backgroundColor: c.surface, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    button: {
      minHeight: 44,
      padding: spacing.md,
      borderRadius: radius.pill,
      justifyContent: "center",
      backgroundColor: c.surfaceChip,
    },
    label: {
      color: c.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
    },
    note: {
      color: c.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    body: {
      color: c.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
    },
    title: {
      color: c.textPrimary,
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
    },
    input: {
      color: c.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      minHeight: 100,
      padding: spacing.md,
      borderRadius: radius.control,
      backgroundColor: c.surface,
    },
    danger: { color: c.destructive },
    scrim: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.lg,
      backgroundColor: c.overlay,
    },
    dialog: {
      backgroundColor: c.surfaceElevated,
      padding: spacing.lg,
      gap: spacing.md,
      borderRadius: radius.container,
      width: "100%",
      maxWidth: 420,
    },
  });
