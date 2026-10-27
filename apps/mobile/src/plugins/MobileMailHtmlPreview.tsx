import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { applyMailInlineEdits, mailInlineDocument, mailInlineBindingScript, mailInlineRefreshScript, type MailInlineImage } from '@cindy/maker-shared/mail-text-edit';
import { WebView } from 'react-native-webview';
import { interceptHtmlNavigation } from '@/session/htmlNavigationPolicy';
import { useBotGroupRemoteMedia } from '@/session/useBotGroupRemoteMedia';
import { useThemedStyles, spacing, typeScale, lineHeight, fontWeight, type ThemeColors } from '@/theme';

/** CID substitution is preview-only. Never pass fetched URLs back into the draft. */
export function MobileMailHtmlPreview({ html, images = [], deviceId, disabled, onChange }: {
  html: string; images?: { cid: string; url: string }[]; deviceId: string;
  disabled?: boolean; onChange?: (html: string, text: string) => void;
}) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles);
  const resolve = useBotGroupRemoteMedia(deviceId);
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<{ binding: string; urls: Record<string, string> }>();
  const binding = JSON.stringify([deviceId, images]);
  useEffect(() => {
    let active = true;
    const urls: Record<string, string> = {};
    let previewBytes = 0;
    void (async () => {
      // Resolve sequentially through the shared media queue; keep all mailbox
      // HTML inert even when one image is unavailable.
      for (const image of images) {
        if (!active || previewBytes > 8 * 1024 * 1024) return;
        try {
          const media = await resolve({ kind: 'image', url: image.url, thumbnail: true, previewable: true });
          if (!active) return;
          if (media.url.startsWith('data:image/')) urls[image.cid] = media.url;
          else {
            const response = await fetch(media.url);
            const blob = await response.blob();
            if (blob.size > 2 * 1024 * 1024) continue;
            urls[image.cid] = await new Promise<string>((done, reject) => {
              const reader = new FileReader();
              reader.onload = () => done(String(reader.result)); reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }
          if (active) setResolved({ binding, urls: { ...urls } });
          previewBytes += urls[image.cid]?.length || 0;
        } catch { /* Preserve the remaining preview when an image cannot be fetched. */ }
      }
    })();
    return () => { active = false; };
  }, [binding, resolve]);
  const urls = resolved?.binding === binding ? resolved.urls : {};
  const previewImages = Object.entries(urls).map(([cid, url]) => ({ cid, url }));
  return <View style={styles.root}>
    <View style={styles.controls}>
    <Pressable accessibilityRole="button" accessibilityLabel={t('plugins.mailEnlarge')} style={styles.enlarge} onPress={() => setOpen(true)}>
      <Text style={styles.note}>{t('plugins.mailEnlarge')}</Text>
    </Pressable>
    </View>
    <View style={styles.preview}><MobileMailFrame html={html} images={previewImages} disabled={disabled || open} onChange={onChange} /></View>
    <Modal visible={open} presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <View style={styles.sheet}>
        <View style={styles.header}><Text style={styles.title}>{t('plugins.mailPreview')}</Text>
          <Pressable accessibilityRole="button" style={styles.enlarge} onPress={() => setOpen(false)}><Text style={styles.note}>{t('common.close')}</Text></Pressable></View>
        <MobileMailFrame html={html} images={previewImages} disabled={disabled} onChange={onChange} />
      </View>
    </Modal>
  </View>;
}
/** This is an email-only bridge; arbitrary HTML file previews keep their existing
 * reader with no message handler. Author scripts are blocked before parsing. */
function MobileMailFrame({ html, images, disabled, onChange }: {
  html: string; images: MailInlineImage[]; disabled?: boolean; onChange?: (html: string, text: string) => void;
}) {
  const web = useRef<WebView>(null);
  const model = useRef({ source: html, emitted: html, received: html, edits: {} as Record<string, string>, revision: 0 });
  if (model.current.received !== html) {
    if (html !== model.current.emitted) model.current = { source: html, emitted: html, received: html, edits: {}, revision: model.current.revision + 1 };
    else model.current.received = html;
  }
  const revision = model.current.revision;
  const source = useMemo(() => ({ baseUrl: 'about:blank', html: mailInlineDocument(model.current.source, images) }), [revision]);
  const settled = useRef(false), lastSource = useRef(source);
  if (lastSource.current !== source) { lastSource.current = source; settled.current = false; }
  const refresh = mailInlineRefreshScript(Boolean(onChange) && !disabled, images);
  useEffect(() => { web.current?.injectJavaScript(refresh); }, [refresh]);
  return <WebView key={revision} ref={web} source={source} javaScriptEnabled
    originWhitelist={['*']} onShouldStartLoadWithRequest={request => interceptHtmlNavigation(request, settled.current)}
    setSupportMultipleWindows={false} allowFileAccess={false} mediaCapturePermissionGrantType="deny"
    keyboardDisplayRequiresUserAction scrollEnabled
    onLoadEnd={() => { settled.current = true; web.current?.injectJavaScript(mailInlineBindingScript(revision) + refresh); }}
    onMessage={event => {
      if (disabled || !onChange || event.nativeEvent.data.length > 100000) return;
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type !== 'mail-text' || data.documentId !== model.current.revision || typeof data.id !== 'string' || typeof data.text !== 'string') return;
        const edits = { ...model.current.edits, [data.id]: data.text };
        const next = applyMailInlineEdits(model.current.source, edits);
        if (!next) return;
        model.current.edits = edits; model.current.emitted = next.html;
        onChange(next.html, next.text);
      } catch { /* Invalid/stale messages never modify or send a draft. */ }
    }} style={{ flex: 1 }} />;
}
const makeStyles = (c: ThemeColors) => StyleSheet.create({
  root: { width: '100%' }, preview: { height: 280 },
  controls: { flexDirection: 'row', justifyContent: 'flex-end' },
  sheet: { flex: 1, padding: spacing.lg, backgroundColor: c.surface },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  enlarge: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-end', paddingHorizontal: spacing.sm },
  title: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold, color: c.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
});
