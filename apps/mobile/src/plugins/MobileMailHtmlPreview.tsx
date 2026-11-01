import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, View } from 'react-native';
import { applyMailInlineEdits, mailInlineDocument, mailReadingDocument, mailReadingThemeScript, mailInlineBindingScript, mailInlineRefreshScript, type MailInlineImage } from '@cindy/maker-shared/mail-text-edit';
import { WebView } from 'react-native-webview';
import { interceptHtmlNavigation } from '@/session/htmlNavigationPolicy';
import { useBotGroupRemoteMedia } from '@/session/useBotGroupRemoteMedia';
import { MessageListRevealContext } from '@/session/messageListReveal';
import { useTheme } from '@/theme';

/** Native injection only (the document CSP blocks page scripts). Lays the message out at
 * its natural height, shrinking fixed-width newsletters to the screen like a mail app,
 * so the page or chat scrolls the body together with its header. Typing re-measures. */
const MAIL_FIT_SCRIPT = `(function(){
  var root=document.documentElement,body=document.body;if(!body)return;
  if(!window.__cindyMailFit){
    // iOS zooms into focused text under 16px; the frame would then clip the enlarged
    // content. The page owns scrolling and sizing, so the document never zooms.
    var viewport=document.querySelector('meta[name=viewport]');
    if(viewport)viewport.setAttribute('content','width=device-width,initial-scale=1,maximum-scale=1');
    var queued=false;
    var measure=function(){
      queued=false;
      body.style.zoom='';
      var width=root.clientWidth||window.innerWidth,wide=Math.max(root.scrollWidth,body.scrollWidth);
      // Before native layout the frame can be 0 wide; text would wrap per character.
      if(!width)return;
      var zoom=width>0&&wide>width+1?width/wide:1;
      if(zoom<1)body.style.zoom=String(zoom);
      var range=document.createRange();range.selectNodeContents(body);
      var css=getComputedStyle(body),end=(parseFloat(css.marginBottom)||0)+(parseFloat(css.paddingBottom)||0);
      var height=Math.ceil(range.getBoundingClientRect().bottom+window.scrollY+end*zoom);
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'mail-size',height:height}));
    };
    window.__cindyMailFit=function(){if(!queued){queued=true;requestAnimationFrame(measure)}};
    document.addEventListener('load',window.__cindyMailFit,true);
    document.addEventListener('error',window.__cindyMailFit,true);
    document.addEventListener('input',window.__cindyMailFit);
    window.addEventListener('resize',window.__cindyMailFit);
    // The page or chat owns scrolling; WebKit's caret reveal must not shift the document.
    window.addEventListener('scroll',function(){if(window.scrollX||window.scrollY)window.scrollTo(0,0)});
    if(document.fonts)document.fonts.ready.then(window.__cindyMailFit);
    setTimeout(window.__cindyMailFit,500);
  }
  window.__cindyMailFit();
})();true;`;

/** Editing inside a chat card: report the caret (viewport px) so the list can keep
 * it above the keyboard. Only sent while a mail text run has focus. */
const MAIL_CARET_SCRIPT = `(function(){
  if(window.__cindyMailCaret)return;window.__cindyMailCaret=true;var queued=false;
  var send=function(){
    queued=false;var sel=document.getSelection();
    var node=sel&&sel.rangeCount?sel.getRangeAt(0):null;
    var run=document.activeElement&&document.activeElement.closest&&document.activeElement.closest('[data-cindy-mail-run]');
    if(!node||!run)return;
    var rect=node.getClientRects()[0]||node.getBoundingClientRect();
    if(!rect||(!rect.height&&!rect.top))rect=run.getBoundingClientRect();
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'mail-caret',top:rect.top,bottom:rect.bottom}));
  };
  var queue=function(){if(!queued){queued=true;requestAnimationFrame(send)}};
  document.addEventListener('selectionchange',queue);document.addEventListener('input',queue);
  document.addEventListener('focusin',queue);
})();true;`;

/** CID substitution is preview-only. Never pass fetched URLs back into the draft.
 * The whole message is shown inline at full height; there is no separate enlarged view. */
export function MobileMailHtmlPreview({ html, images = [], deviceId, disabled, onChange }: {
  html: string; images?: { cid: string; url: string }[]; deviceId: string;
  disabled?: boolean; onChange?: (html: string, text: string) => void;
}) {
  const resolve = useBotGroupRemoteMedia(deviceId);
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
  return <MobileMailFrame html={html} images={previewImages} disabled={disabled} onChange={onChange} />;
}
/** This is an email-only bridge; arbitrary HTML file previews keep their existing
 * reader with no message handler. Author scripts are blocked before parsing. */
function MobileMailFrame({ html, images, disabled, onChange }: {
  html: string; images: MailInlineImage[]; disabled?: boolean; onChange?: (html: string, text: string) => void;
}) {
  const web = useRef<WebView>(null), frame = useRef<View>(null);
  const [height, setHeight] = useState<number>();
  const reveal = useContext(MessageListRevealContext);
  const caret = useRef<{ top: number; bottom: number } | undefined>(undefined);
  const revealCaret = () => {
    const rect = caret.current;
    if (!rect || !reveal) return;
    frame.current?.measureInWindow((_x, y) => { if (Number.isFinite(y)) reveal({ top: y + rect.top, bottom: y + rect.bottom }); });
  };
  const revealRef = useRef(revealCaret); revealRef.current = revealCaret;
  // The list shrinks above the keyboard only after it appears; re-check then.
  useEffect(() => {
    if (!onChange) return;
    const sub = Keyboard.addListener('keyboardDidShow', () => setTimeout(() => revealRef.current(), 50));
    const hide = Keyboard.addListener('keyboardDidHide', () => { caret.current = undefined; });
    return () => { sub.remove(); hide.remove(); };
  }, [Boolean(onChange)]);
  const { mode, colors } = useTheme();
  const model = useRef({ source: html, emitted: html, received: html, edits: {} as Record<string, string>, revision: 0 });
  if (model.current.received !== html) {
    if (html !== model.current.emitted) model.current = { source: html, emitted: html, received: html, edits: {}, revision: model.current.revision + 1 };
    else model.current.received = html;
  }
  const revision = model.current.revision;
  const editable = Boolean(onChange);
  const source = useMemo(() => ({ baseUrl: 'about:blank', html: (editable ? mailInlineDocument : mailReadingDocument)(model.current.source, images) }), [revision, editable]);
  const settled = useRef(false), lastSource = useRef(source);
  if (lastSource.current !== source) { lastSource.current = source; settled.current = false; }
  const appearance = editable ? '' : mailReadingThemeScript(mode === 'dark', { surface: colors.surface, text: colors.textPrimary });
  const refresh = mailInlineRefreshScript(Boolean(onChange) && !disabled, images) + appearance + MAIL_FIT_SCRIPT + (editable ? MAIL_CARET_SCRIPT : '');
  useEffect(() => { web.current?.injectJavaScript(refresh); }, [refresh]);
  return <View ref={frame} collapsable={false} style={{ width: '100%' }}><WebView key={revision} ref={web} source={source} javaScriptEnabled
    originWhitelist={['*']} onShouldStartLoadWithRequest={request => interceptHtmlNavigation(request, settled.current)}
    setSupportMultipleWindows={false} allowFileAccess={false} mediaCapturePermissionGrantType="deny"
    keyboardDisplayRequiresUserAction scrollEnabled={false} bounces={false}
    automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
    showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false}
    onLoadEnd={() => { settled.current = true; web.current?.injectJavaScript(mailInlineBindingScript(revision) + refresh); }}
    onMessage={event => {
      if (event.nativeEvent.data.length > 100000) return;
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'mail-caret') {
          if (editable && typeof data.top === 'number' && typeof data.bottom === 'number' && Number.isFinite(data.top) && Number.isFinite(data.bottom)) {
            caret.current = { top: data.top, bottom: data.bottom };
            revealCaret();
          }
          return;
        }
        if (data.type === 'mail-size') {
          // The page owns scrolling; a stray size only resizes this frame.
          if (typeof data.height === 'number' && data.height > 0 && data.height <= 1_000_000) {
            const next = Math.ceil(data.height);
            setHeight(old => old !== undefined && Math.abs(old - next) <= 1 ? old : next);
          }
          return;
        }
        if (disabled || !onChange) return;
        if (data.type !== 'mail-text' || data.documentId !== model.current.revision || typeof data.id !== 'string' || typeof data.text !== 'string') return;
        const edits = { ...model.current.edits, [data.id]: data.text };
        const next = applyMailInlineEdits(model.current.source, edits);
        if (!next) return;
        model.current.edits = edits; model.current.emitted = next.html;
        onChange(next.html, next.text);
      } catch { /* Invalid/stale messages never modify or send a draft. */ }
    }} containerStyle={{ flex: 0, width: '100%', height: height ?? MAIL_FIT_INITIAL_HEIGHT }} style={{ flex: 1 }} /></View>;
}
// Placeholder until the first measurement; most messages report within a frame.
const MAIL_FIT_INITIAL_HEIGHT = 160;
