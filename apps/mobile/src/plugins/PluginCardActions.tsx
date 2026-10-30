import { useEffect, useRef, useState } from "react";
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
} from "@cindy/maker-shared/ghost-card-form";
import {
  Alert,
  AppState,
  Linking,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  type PluginPageConfirm,
  type PluginPagePoll,
} from "@cindy/device-link";
import { Text, TextInput } from "@/components/AppText";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { useAuth } from "@/auth/AuthContext";
import { MobileMailHtmlPreview } from "./MobileMailHtmlPreview";
import { pickMobileMailAttachment } from "./mobileMailAttachment";
import { PluginCardRecipients } from "./PluginCardRecipients";
import { invokePlugin } from "./pluginClient";
import { FileTypeIcon } from '@/components/FileTypeIcon';
import { formatByteSize } from '@cindy/maker-shared/file-preview';

interface Action {
  id: string;
  label: string;
  prompt?: string;
  url?: string;
  disabled: boolean;
  submit?: boolean;
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
      (item.url === undefined || typeof item.url === "string"),
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
  };
}
export function PluginCardActions({
  data,
  deviceId,
  sessionId,
  callId,
  onOpenAttachment,
}: {
  data: unknown;
  deviceId?: string;
  sessionId: string;
  callId: string;
  onOpenAttachment?: (url: string, name: string) => void;
}) {
  const parsed = parse(data);
  return parsed && !parsed.mail?.supersededBy && deviceId ? (
    <CardControls
      key={`${deviceId}:${sessionId}:${callId}:${parsed.pluginId}`}
      {...parsed}
      deviceId={deviceId}
      sessionId={sessionId}
      callId={callId}
      onOpenAttachment={onOpenAttachment}
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
  deviceId,
  sessionId,
  callId,
  onOpenAttachment,
}: {
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
}) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const history = !!mail?.supersededBy || !!legacyMail;
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
        if (!disposed && current()) setConfirm(result.confirms[0]);
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
      let url: URL;
      try {
        url = new URL(action.url);
      } catch {
        return;
      }
      if (!["http:", "https:"].includes(url.protocol)) return;
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
      {history ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: historyExpanded }} onPress={() => setHistoryExpanded(!historyExpanded)}>
        <Text style={styles.note}>{historyExpanded ? '▾ ' : '▸ '}{t(legacyMail ? 'plugins.mailLegacy' : 'plugins.mailUpdated')}{' · '}{form?.find(f => f.name === 'subject')?.value}</Text>
      </Pressable> : null}
      {history && historyExpanded ? <View style={styles.root}>{form?.filter(f => f.value && f.kind !== 'hidden' && (f.kind !== 'mail-attachments' || visibleMailAttachments(formValues, f.name).length)).map(field =>
        <View key={field.name}><Text style={styles.note}>{field.label}</Text>
          {field.kind === 'mail-html' ? <MobileMailHtmlPreview html={field.value} images={mailPreviewImages(formValues, mail?.images)} deviceId={deviceId} /> :
            <Text style={styles.body}>{field.kind === 'mail-attachments' ? visibleMailAttachments(formValues, field.name).map(file => file.filename).join(' · ') : field.value}</Text>}
        </View>
      )}</View> : null}
      {!history ? <View style={styles.form}>
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
      <View style={mail && !history ? styles.mailFooter : undefined}>
        {mail && !history ? (
          <View style={styles.mailInfo}>
            <Text style={styles.note}>{mail.fromLabel}: {mail.from}</Text>
            {mail.attachments.length && !form?.some(f => f.kind === 'mail-attachments') ? (
              <Text style={styles.note}>{mail.attachments.join(' · ')}</Text>
            ) : null}
            <Text style={styles.note}>{mailCardStatus(mail, countdownNow)}</Text>
          </View>
        ) : null}
        <View style={styles.actions}>
          {(history ? [] : items).map((action) => {
            const sendNow = !!mail?.pendingSend && action.id === `mail:now:${mail.key}`;
            return (
              <Pressable
                key={action.id}
                accessibilityRole="button"
                accessibilityLabel={sendNow && mail ? `${action.label}, ${mailCardStatus(mail, countdownNow)}` : action.label}
                disabled={action.disabled || busy || uploading || unknown || status !== "online" || (readonly && !mail?.pendingSend && !action.id.startsWith('mail:continue:'))}
                style={[styles.button, mail && action.id === `mail:send:${mail.key}` && styles.sendButton, sendNow && styles.sendNowButton]}
                onPress={() => choose(action)}
              >
                {sendNow && mail ? (
                  <View pointerEvents="none" accessible={false} style={StyleSheet.absoluteFill}>
                    <View style={[styles.countdownFill, { width: `${(1 - mailSendRemainingFraction(mail, countdownNow)) * 100}%` }]} />
                  </View>
                ) : null}
                <Text style={[styles.label, mail && action.id === `mail:send:${mail.key}` && styles.sendLabel]}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
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
    sendButton: { backgroundColor: c.cta },
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
