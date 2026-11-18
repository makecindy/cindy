import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { WebView } from 'react-native-webview';
import { MAX_FONT_SIZE_MULTIPLIER } from '@/components/AppText';
import { useWindowFontScale } from '@/platform/windowDimension';
import { lineHeight, useTheme } from '@/theme';
import { MarkdownBlockCopyButton } from './MarkdownBlockCopyButton';
import { useChatPathInteraction } from './ChatPathChipSpan';
import { useOpenMailLink } from './MailLinkSpan';
import { useOpenSettingsLink } from './SettingsLinkSpan';
import { useMarkdownSessionLink } from './useMarkdownSessionLink';
import { useMarkdownSessionLinkTitles } from './useMarkdownSessionLinkTitles';
import { classifyChatPathLinkTarget, classifyInlineCodePathCandidate, chatPathLabelReadsAsFileReference } from './chatPathCandidate';
import { parseSessionDeepLinkUrl } from './sessionLinks';
import { parseSettingsNavigationUrl, type SettingsNavigationTarget } from '@cindy/maker-shared/settings-navigation';
import { RichContentContext, useDeferredRichContent } from './richContentContext';
import { registerMobileMessageWebView } from './mobileMessageWebViewMetrics';
import { SelectionQuoteContext, commitSelectionMenuAction, selectionQuoteMenuLabel } from './selectionQuote';
import { interceptHtmlNavigation } from './htmlNavigationPolicy';
import type { MessageContentLayout } from './messageContentLayout';
import { MessageListVisibility, useMessageListItemVisible } from './messageListVisibility';
import type { MobileMarkdownBlock } from './messageMarkdown';
import { TABLE_MESSAGE_SHELL, buildTableMessageContent, parseTableMessageObservation, tableMessageCss, tableMessageUpdateScript,
  type TableMessageLink, type TableMessageLinkState, type TableMessageDocument as Document } from './tableMessageHtml';

export interface TableDocumentListScope {
  visibility: MessageListVisibility;
  pin: (key: string, active: boolean, owner: string) => void;
}
export const TableDocumentListContext = createContext<TableDocumentListScope | null>(null);
export const TableDocumentRowContext = createContext<{ key: string; visible: boolean; pin: TableDocumentListScope['pin'] } | null>(null);

/** Adds only the table carrier's viewport/selection rules to the existing list. */
export function useTableDocumentList(scope: unknown) {
  const visibility = useMemo(() => new MessageListVisibility(), [scope]);
  const [selected, setSelected] = useState<{ scope: unknown; key: string; owner: string } | null>(null);
  const pin = useCallback((key: string, active: boolean, owner: string) => setSelected(previous => {
    if (active) return previous && previous.scope === scope && previous.key === key && previous.owner === owner
      ? previous : { scope, key, owner };
    return previous && previous.scope === scope && previous.key === key && previous.owner === owner ? null : previous;
  }), [scope]);
  const context = useMemo(() => ({ visibility, pin }), [visibility, pin]);
  const viewability = useMemo(() => [{
    viewabilityConfig: { id: 'table-body-viewport', viewAreaCoveragePercentThreshold: 0.1 },
    onViewableItemsChanged: ({ viewableItems }: { viewableItems: { key: string; isViewable: boolean }[] }) => visibility.update(viewableItems),
  }], [visibility]);
  const alwaysRender = useMemo(() => selected && selected.scope === scope ? { keys: [selected.key] } : undefined, [scope, selected]);
  return { context, viewability, alwaysRender };
}

export function TableDocumentRow({ rowKey, children }: { rowKey: string; children: ReactNode }) {
  const list = useContext(TableDocumentListContext);
  const visible = useMessageListItemVisible(rowKey, list?.visibility);
  const value = useMemo(() => list ? { key: rowKey, visible, pin: list.pin } : null, [list, rowKey, visible]);
  return <TableDocumentRowContext.Provider value={value}>{children}</TableDocumentRowContext.Provider>;
}
let nextDocument = 0;
type Slot = { id: string; top: number; height: number };
type LinkAction = { onPress?: () => void; onLongPress?: () => void };

/** Android single-message text carrier. Its document has no network or URL bridge. */
export function TableMessageDocument({ text, blocks, layout, streaming, selectable, codeCopyEnabled = true,
  documentKey, initialHeight, onOpenSessionLink, onMeasured, onReady, onFailure }: {
  text: string; blocks: readonly MobileMarkdownBlock[]; layout: MessageContentLayout;
  streaming?: boolean; selectable?: boolean; codeCopyEnabled?: boolean;
  documentKey: string; initialHeight?: number; onOpenSessionLink?: (url: string) => void;
  /** Optional local diagnostics; not exposed to the document or persisted. */
  onMeasured?: (height: number) => void;
  onReady?: () => void;
  onFailure?: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const scale = Math.min(useWindowFontScale(), MAX_FONT_SIZE_MULTIPLIER);
  const runtime = useContext(RichContentContext);
  const row = useContext(TableDocumentRowContext);
  const quote = useContext(SelectionQuoteContext);
  const latestQuote = useRef(quote);
  useLayoutEffect(() => { latestQuote.current = quote; }, [quote]);
  const [width, setWidth] = useState(0);
  const [selectionActive, setSelectionActive] = useState(false);
  const [height, setHeight] = useState(() => initialHeight || Math.max(100,
    Math.ceil(text.length / Math.max(12, layout.markdownTableAvailableWidth / 10)) * lineHeight.bodyLarge));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [linkState, setLinkState] = useState<{ contentId: string; values: Record<string, TableMessageLinkState> } | null>(null);
  const linkActions = useRef({ contentId: '', values: new Map<string, LinkAction>() });
  const view = useRef<WebView>(null);
  const loaded = useRef(false), settled = useRef(false);
  const instance = useRef<number | null>(null);
  if (instance.current === null) instance.current = ++nextDocument;
  const contentVersion = useRef({ key: documentKey, text, version: 0 });
  if (contentVersion.current.key !== documentKey || contentVersion.current.text !== text) {
    contentVersion.current = { key: documentKey, text, version: contentVersion.current.version + 1 };
  }
  const contentId = `${instance.current}:${contentVersion.current.version}`;
  if (linkActions.current.contentId !== contentId) {
    linkActions.current = { contentId, values: new Map() };
  }
  const content = useMemo(() => buildTableMessageContent(blocks, { width, layout, copyEnabled: codeCopyEnabled, streaming }),
    [blocks, width, layout, codeCopyEnabled, streaming]);
  const displayStates = Object.fromEntries(content.links.map(link => [link.id,
    (linkState?.contentId === contentId ? linkState.values[link.id] : undefined)
      ?? { text: link.text, lit: false, code: link.code }]));
  const heightKey = JSON.stringify(['table-body-height', documentKey, text, width, scale, layout, codeCopyEnabled,
    content.copies.length, Object.values(displayStates).map(state => [state.text, state.code])]);
  const mounted = useDeferredRichContent(width > 0 && ((row?.visible ?? true) || selectionActive), contentId);
  const generation = useRef({ mounted: false, value: 0 });
  if (generation.current.mounted !== mounted) {
    generation.current = { mounted, value: generation.current.value + 1 };
    loaded.current = false; settled.current = false;
  }
  const layoutSignature = JSON.stringify([width, scale, layout, colors, codeCopyEnabled,
    selectable, streaming, Object.values(displayStates)]);
  const layoutVersion = useRef({ signature: '', version: 0 });
  if (layoutVersion.current.signature !== layoutSignature) {
    layoutVersion.current = { signature: layoutSignature, version: layoutVersion.current.version + 1 };
  }
  const revision = `${contentId}:${generation.current.value}:${layoutVersion.current.version}`;
  const current = useRef({ mounted, revision, contentId, heightKey, width });
  current.current = { mounted, revision, contentId, heightKey, width };
  const payload: Document = { revision, html: content.html, css: tableMessageCss(colors, scale, layout, StyleSheet.hairlineWidth),
    selectable: selectable === true && !streaming, links: displayStates };
  const latestPayload = useRef(payload); latestPayload.current = payload;
  const sessionLinkTitles = useMarkdownSessionLinkTitles(text);
  const reportLink = useCallback((id: string, state: TableMessageLinkState, actions: LinkAction) => {
    if (linkActions.current.contentId !== contentId) return;
    linkActions.current.values.set(id, actions);
    setLinkState(previous => {
      const values = previous?.contentId === contentId ? previous.values : {};
      const old = values[id];
      return old && old.text === state.text && old.lit === state.lit && old.code === state.code && old.longPress === state.longPress
        ? previous : { contentId, values: { ...values, [id]: state } };
    });
  }, [contentId]);
  useLayoutEffect(() => {
    setSelectionActive(false);
    row?.pin(row.key, false, contentId);
  }, [contentId]);
  useEffect(() => () => { row?.pin(row.key, false, contentId); }, [row?.key, row?.pin, contentId]);
  useEffect(() => {
    if (!mounted) return;
    return registerMobileMessageWebView('table-body');
  }, [mounted]);
  useLayoutEffect(() => {
    const cached = runtime?.get(heightKey);
    if (!cached) { setSlots([]); return; }
    try {
      const value = JSON.parse(cached);
      if (Number.isFinite(value.height) && value.height > 0 && Array.isArray(value.slots)) {
        setHeight(value.height); setSlots(value.slots);
      }
    } catch { /* Cache misses do not create a new rendering path. */ }
  }, [runtime, heightKey]);
  const update = useCallback(() => {
    if (loaded.current && current.current.mounted) view.current?.injectJavaScript(tableMessageUpdateScript(latestPayload.current));
  }, []);
  useEffect(update, [revision, update]);
  const menuScope = useRef({ callback: quote?.commitQuote, version: 0 });
  if (menuScope.current.callback !== quote?.commitQuote) {
    menuScope.current = { callback: quote?.commitQuote, version: menuScope.current.version + 1 };
  }
  const menuPrefix = `table:${contentId}:${menuScope.current.version}:`;
  const menuItems = useMemo(() => !quote || streaming ? undefined : [
    { key: menuPrefix + 'quote', label: selectionQuoteMenuLabel() },
    ...(quote.askInSideChat ? [{ key: menuPrefix + 'side-chat', label: t('session.sideChat.title') }] : []),
  ], [menuPrefix, quote?.commitQuote, !!quote?.askInSideChat, streaming, t]);
  const maxHeight = Math.ceil((text.length + blocks.length * 8 + 10) * lineHeight.listTitle * scale);
  return <View style={{ height, alignSelf: 'stretch' }} testID="message.tableTextDocument"
    onLayout={event => {
      const next = Math.round(event.nativeEvent.layout.width);
      setWidth(old => old === next ? old : next);
    }}>
    {mounted ? <>
      <WebView ref={view} source={SOURCE} textZoom={100} scrollEnabled={false}
        style={{ backgroundColor: 'transparent' }} containerStyle={{ height, flex: 0 }}
        incognito originWhitelist={['*']} allowFileAccess={false} setSupportMultipleWindows={false}
        mediaCapturePermissionGrantType="deny" automaticallyAdjustContentInsets={false}
        onShouldStartLoadWithRequest={request => interceptHtmlNavigation(request, settled.current)}
        onLoadStart={() => { loaded.current = false; settled.current = false; }}
        onLoadEnd={() => { loaded.current = true; settled.current = true; update(); }}
        onError={onFailure}
        onRenderProcessGone={onFailure}
        menuItems={menuItems}
        onCustomMenuSelection={event => {
          const now = current.current, ctx = latestQuote.current;
          if (!now.mounted || !ctx || now.contentId !== contentId || ctx.commitQuote !== quote?.commitQuote) return;
          const action = event.nativeEvent.key === menuPrefix + 'quote' ? 'quote'
            : event.nativeEvent.key === menuPrefix + 'side-chat' ? 'side-chat' : null;
          if (action) commitSelectionMenuAction(action, event.nativeEvent.selectedText, ctx);
        }}
        onMessage={event => {
          const now = current.current;
          if (!now.mounted) return;
          const value = parseTableMessageObservation(event.nativeEvent.data, now.revision, maxHeight);
          if (!value) return;
          if (value.kind === 'selection') {
            setSelectionActive(value.active); row?.pin(row.key, value.active, contentId); return;
          }
          if (value.kind === 'link') {
            if (!content.links.some(link => link.id === value.id)) return;
            const action = linkActions.current.values.get(value.id);
            if (value.action === 'open') action?.onPress?.(); else action?.onLongPress?.();
            return;
          }
          if (Math.round(value.width) !== now.width) return;
          const nextSlots = value.slots.filter(slot => content.copies.some(copy => copy.id === slot.id));
          setHeight(old => old === value.height ? old : value.height);
          setSlots(old => JSON.stringify(old) === JSON.stringify(nextSlots) ? old : nextSlots);
          runtime?.set(now.heightKey, JSON.stringify({ height: value.height, slots: nextSlots }));
          onMeasured?.(value.height);
          onReady?.();
        }} />
      {content.links.map(link => <TableLinkController key={`${contentId}:${link.id}`} link={link} streaming={streaming}
        onOpenSessionLink={onOpenSessionLink} sessionLinkTitles={sessionLinkTitles} report={reportLink} />)}
      {slots.map(slot => {
        const copy = content.copies.find(item => item.id === slot.id);
        return copy ? <View key={copy.id} pointerEvents="box-none" style={{ position: 'absolute', top: slot.top,
          left: 0, right: 0, height: slot.height }}>
          <MarkdownBlockCopyButton text={copy.text} kind={copy.kind} />
        </View> : null;
      })}
    </> : null}
  </View>;
}
const SOURCE = { html: TABLE_MESSAGE_SHELL, baseUrl: 'about:blank' };

type ControllerProps = {
  link: TableMessageLink; streaming?: boolean; onOpenSessionLink?: (url: string) => void;
  sessionLinkTitles?: Readonly<Record<string, string>>;
  report: (id: string, state: TableMessageLinkState, actions: LinkAction) => void;
};
const TableLinkController = memo(function TableLinkController(props: ControllerProps) {
  const { inline } = props.link;
  if (inline.type === 'code') return <PathController {...props} />;
  if (inline.type !== 'link') return null;
  const settings = parseSettingsNavigationUrl(inline.url);
  if (settings) return <SettingsController {...props} target={settings} />;
  const session = parseSessionDeepLinkUrl(inline.url);
  if (session) return <SessionController {...props} session={session} />;
  if (classifyChatPathLinkTarget(inline.url)) return <PathController {...props} />;
  return <MailController {...props} url={inline.url} />;
});
function useReportLink(props: ControllerProps, state: TableMessageLinkState, actions: LinkAction) {
  useLayoutEffect(() => props.report(props.link.id, state, actions),
    [props.report, props.link.id, state.text, state.lit, state.code, state.longPress, actions.onPress, actions.onLongPress]);
}
function PathController(props: ControllerProps) {
  const { inline } = props.link;
  const candidate = useMemo(() => inline.type === 'code' ? classifyInlineCodePathCandidate(inline.text)
    : inline.type === 'link' ? classifyChatPathLinkTarget(inline.url) : null, [inline]);
  const explicit = inline.type === 'link' && !inline.bare;
  const action = useChatPathInteraction({ candidate, explicitLink: explicit, streaming: props.streaming });
  const code = inline.type === 'code' || !!(explicit && candidate && inline.type === 'link'
    && chatPathLabelReadsAsFileReference(inline.text, candidate, inline.url) && action.lit);
  useReportLink(props, { text: props.link.text, lit: action.lit, code, longPress: !!action.onLongPress }, action);
  return null;
}
function MailController(props: ControllerProps & { url: string }) {
  const onPress = useOpenMailLink(props.url);
  useReportLink(props, { text: props.link.text, lit: true }, { onPress });
  return null;
}
function SettingsController(props: ControllerProps & { target: SettingsNavigationTarget }) {
  const onPress = useOpenSettingsLink(props.target);
  useReportLink(props, { text: props.link.text, lit: true }, { onPress });
  return null;
}
function SessionController(props: ControllerProps & { session: NonNullable<ReturnType<typeof parseSessionDeepLinkUrl>> }) {
  const inline = props.link.inline;
  if (inline.type !== 'link') throw new Error('Expected a parsed session link');
  const action = useMarkdownSessionLink({ inline, session: props.session,
    sessionLinkTitles: props.sessionLinkTitles, onOpenSessionLink: props.onOpenSessionLink });
  useReportLink(props, { text: action.text, lit: !!action.onPress }, action);
  return null;
}
