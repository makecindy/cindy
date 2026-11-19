import { Component, Fragment, createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type CSSProperties } from 'react';
import { A2uiSurface, createComponentImplementation, createBinderlessComponentImplementation, type ReactCatalogComponent } from '@cindy/a2ui-renderer/react';
import { MessageProcessor, Catalog, STRICT_VALIDATION, TextApi, ImageApi, AudioPlayerApi, ButtonApi, TextFieldApi, TabsApi, RowApi, ColumnApi, CardApi, DividerApi, ChoicePickerApi, type SurfaceModel } from '@cindy/a2ui-renderer/core';
import { RichInteractionMemory, RichSubmissionController, type RichNode } from '@cindy/maker-shared/rich-answer';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { Spinner } from '@/components/ui/spinner';
import { useSessionQuickSend } from './SessionQuickSendContext';
import { a2uiSubmissionText, readA2uiMessages, A2UI_BASIC_CATALOG } from './a2uiMessage';
import './a2ui-answer.css';

const memory = new RichInteractionMemory({
  async read() { return localStorage.getItem('cindy.a2ui.viewState.v1'); },
  async write(value) { localStorage.setItem('cindy.a2ui.viewState.v1', value); },
  writeSync(value) { localStorage.setItem('cindy.a2ui.viewState.v1', value); },
});
const submissions = new RichSubmissionController(memory);
type ActiveSubmission = { componentId: string; text: string; receipt?: Promise<boolean> };
type Ports = {
  stateKey: string;
  renderMarkdown: (text: string, id: string) => ReactNode;
  renderMedia: (node: RichNode) => ReactNode;
  /** A dispatch is admitted only while this explicitly clicked button is active. */
  dispatch: (componentId: string, text: string, action: () => Promise<void>) => Promise<boolean>;
};
const Host = createContext<Ports | null>(null);
const useHost = () => {
  const host = useContext(Host);
  if (!host) throw new Error('Missing A2UI host');
  return host;
};
const textComponent = createComponentImplementation(TextApi, ({ props, context }) => {
  const host = useHost();
  return <div className="cindy-a2ui-text" data-variant={props.variant}>{host.renderMarkdown(props.text ?? '', context.componentModel.id)}</div>;
});
const imageComponent = createComponentImplementation(ImageApi, ({ props, context }) => useHost().renderMedia({
  id: context.componentModel.id, kind: 'image', props: { src: props.url, ...(props.description ? { alt: props.description } : {}) }, children: [],
}));
const audioComponent = createComponentImplementation(AudioPlayerApi, ({ props, context }) => useHost().renderMedia({
  id: context.componentModel.id, kind: 'audio', props: { src: props.url, ...(props.description ? { alt: props.description } : {}) }, children: [],
}));
const fieldComponent = createComponentImplementation(TextFieldApi, ({ props }) => <FormField label={props.label}>
  {({ error: _error, ...control }) => props.variant === 'longText'
    ? <Textarea {...control} value={props.value ?? ''} placeholder={props.placeholder} onChange={value => props.setValue?.(value)} />
    : <Input {...control} type={props.variant === 'number' ? 'number' : props.variant === 'obscured' ? 'password' : 'text'} value={props.value ?? ''} placeholder={props.placeholder} onChange={value => props.setValue?.(value)} />}
</FormField>);
const tabsComponent = createComponentImplementation(TabsApi, ({ props, context, buildChild }) => {
  const host = useHost();
  const key = `${host.stateKey}:tabs:${context.componentModel.id}`;
  const saved = useSyncExternalStore(memory.subscribe, () => memory.get(key).index);
  const index = typeof saved === 'number' && Number.isInteger(saved) && saved >= 0 && saved < props.tabs.length ? saved : 0;
  return <div className="cindy-a2ui-navigation">
    <div className="cindy-a2ui-tabs">{props.tabs.map((tab, position) => <Button key={position} type="button" variant={index === position ? 'primary' : 'secondary'} aria-pressed={index === position} onClick={() => memory.set(key, { index: position })}>{tab.title}</Button>)}</div>
    <div>{props.tabs[index] && buildChild(props.tabs[index].child)}</div>
  </div>;
});
const layoutStyle = (props: { align?: 'start' | 'center' | 'end' | 'stretch'; justify?: 'start' | 'center' | 'end' | 'stretch' | 'spaceAround' | 'spaceBetween' | 'spaceEvenly' }): CSSProperties => ({
  alignItems: props.align,
  justifyContent: ({ spaceAround: 'space-around', spaceBetween: 'space-between', spaceEvenly: 'space-evenly', start: 'start', end: 'end', center: 'center', stretch: 'stretch' } as const)[props.justify ?? 'start'],
});
const rowComponent = createComponentImplementation(RowApi, ({ props, buildChild }) => <div className="cindy-a2ui-row" style={layoutStyle(props)}>{props.children.map(child => <Fragment key={typeof child === 'string' ? child : `${child.id}:${child.basePath}`}>{typeof child === 'string' ? buildChild(child) : buildChild(child.id, child.basePath)}</Fragment>)}</div>);
const columnComponent = createComponentImplementation(ColumnApi, ({ props, buildChild }) => <div className="cindy-a2ui-column" style={layoutStyle(props)}>{props.children.map(child => <Fragment key={typeof child === 'string' ? child : `${child.id}:${child.basePath}`}>{typeof child === 'string' ? buildChild(child) : buildChild(child.id, child.basePath)}</Fragment>)}</div>);
const cardComponent = createComponentImplementation(CardApi, ({ props, buildChild }) => <div className="cindy-a2ui-card">{buildChild(props.child)}</div>);
const dividerComponent = createComponentImplementation(DividerApi, ({ props }) => <hr className="cindy-a2ui-divider" aria-orientation={props.axis} data-axis={props.axis} />);
const choiceComponent = createComponentImplementation(ChoicePickerApi, ({ props }) => {
  const [filter, setFilter] = useState('');
  const values: string[] = props.value ?? [];
  return <div className="cindy-a2ui-column" role="group" aria-label={props.label}>
    {props.label && <p>{props.label}</p>}
    {props.filterable && <Input value={filter} onChange={setFilter} ariaLabel={props.label} />}
    <div className="cindy-a2ui-tabs">{props.options.filter(option => !filter || option.label.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(option => <Button key={option.value} type="button" variant="secondary" aria-pressed={values.includes(option.value)} onClick={() => props.setValue?.(props.variant === 'multipleSelection'
      ? values.includes(option.value) ? values.filter(value => value !== option.value) : [...values, option.value]
      : [option.value])}>{option.label}</Button>)}</div>
  </div>;
});

const buttonComponent = createBinderlessComponentImplementation(ButtonApi, ({ context, buildChild }) => {
  const host = useHost();
  const sender = useSessionQuickSend();
  const { t } = useTranslation();
  const [, refresh] = useState(0);
  useEffect(() => {
    const subscription = context.dataContext.dataModel.subscribe('/', () => refresh(value => value + 1));
    return () => subscription.unsubscribe();
  }, [context]);
  const properties = context.componentModel.properties;
  const resolved = context.dataContext.resolveAction(properties.action) as { event?: { name: string; userMessage?: string; context?: Record<string, unknown> } };
  const event = resolved?.event;
  const text = event ? a2uiSubmissionText({ ...event, context: event.context ?? {} }) : undefined;
  const receipt = `${host.stateKey}:button:${context.componentModel.id}`;
  const status = useSyncExternalStore(submissions.subscribe, () => submissions.status(receipt, text));
  const disabled = !sender || !text || status === 'sending' || status === 'sent';
  return <div className="cindy-a2ui-submit">
    {text && <p className="cindy-a2ui-preview">{text}</p>}
    <Button type="button" variant="secondary" disabled={disabled} onClick={() => {
      if (!disabled && event) void submissions.submit(receipt, text, value => host.dispatch(context.componentModel.id, value, () => context.dispatchAction({ event })));
    }}>{status === 'sending' ? t('richAnswer.sending') : status === 'sent' ? t('richAnswer.sent') : buildChild(properties.child)}</Button>
    {status === 'failed' && <p role="alert">{t('richAnswer.sendFailed')}</p>}
  </div>;
});

// Official schemas, processor, binding and surface renderer. Host implementations
// provide the trust boundaries, accessible fields and responsive navigation.
const components: ReactCatalogComponent[] = [textComponent, imageComponent, audioComponent, buttonComponent, fieldComponent, tabsComponent, rowComponent, columnComponent, cardComponent, dividerComponent, choiceComponent];
const catalog = new Catalog<ReactCatalogComponent>(A2UI_BASIC_CATALOG, '1.0', components, []);

class SurfaceBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function A2uiAnswer(props: { source: string; stateKey: string; renderMarkdown: Ports['renderMarkdown']; renderMedia: Ports['renderMedia'] }) {
  const { user } = useAuth();
  const key = `${user?.id ?? 'signed-out'}:${props.stateKey}`;
  return <A2uiDocument key={key} {...props} stateKey={key} />;
}

function A2uiDocument({ source, stateKey, renderMarkdown, renderMedia }: Parameters<typeof A2uiAnswer>[0]) {
  const { t } = useTranslation();
  const sender = useSessionQuickSend();
  const senderRef = useRef(sender);
  senderRef.current = sender;
  const active = useRef<ActiveSubmission | undefined>(undefined);
  const [surface, setSurface] = useState<SurfaceModel<ReactCatalogComponent>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let processor: MessageProcessor<ReactCatalogComponent> | undefined;
    let unsubscribe: (() => void) | undefined;
    setSurface(undefined);
    setFailed(false);
    const save = () => memory.flushSync();
    window.addEventListener('pagehide', save);
    void (async () => {
      try {
        await memory.load();
        if (!alive) return;
        const messages = readA2uiMessages(source);
        let invalid = false;
        processor = new MessageProcessor([catalog], action => {
          const clicked = active.current;
          const text = a2uiSubmissionText(action);
          if (!clicked || clicked.receipt || action.sourceComponentId !== clicked.componentId || text !== clicked.text || !senderRef.current) return;
          // Never infer tools, recipients or permissions from the event payload.
          // v0.15's surface-group forwards events without awaiting its listeners.
          // Keep the host receipt ourselves so slow IPC cannot look like failure.
          clicked.receipt = senderRef.current.send(text, { literalText: true, independent: true }).catch(() => false);
        }, { version: 'v1.0', validationConfig: STRICT_VALIDATION, errorHandler: () => { invalid = true; if (alive) setFailed(true); } });
        processor.processMessages(messages);
        if (invalid) throw new Error('Invalid A2UI');
        const model = [...processor.getSurfaces().values()][0];
        if (!model) throw new Error('Missing A2UI surface');
        // Only local draft state is restored, never reading/mastery progress.
        const saved = memory.get(stateKey).draft;
        if (typeof saved === 'string') model.dataModel.set('/draft', JSON.parse(saved));
        const subscription = model.dataModel.subscribe('/draft', value => {
          const serialized = JSON.stringify(value);
          if (serialized && serialized.length <= 32000) memory.set(stateKey, { draft: serialized });
        });
        unsubscribe = () => subscription.unsubscribe();
        if (alive) setSurface(model);
      } catch { if (alive) setFailed(true); }
    })();
    return () => {
      alive = false;
      window.removeEventListener('pagehide', save);
      unsubscribe?.();
      processor?.dispose();
      memory.flushSync();
      void memory.flush();
    };
  }, [source, stateKey]);
  const fallback = <div className="cindy-a2ui-fallback"><p role="status">{t('richAnswer.incomplete')}</p><pre>{source}</pre></div>;
  if (failed) return fallback;
  if (!surface) return <div role="status" aria-label="A2UI" aria-busy="true"><Spinner /></div>;
  const host: Ports = {
    stateKey, renderMarkdown, renderMedia,
    async dispatch(componentId, text, dispatchAction) {
      if (active.current) return false;
      const clicked: ActiveSubmission = { componentId, text };
      active.current = clicked;
      try { await dispatchAction(); return await (clicked.receipt ?? Promise.resolve(false)); }
      finally { active.current = undefined; }
    },
  };
  return <div className="cindy-a2ui"><SurfaceBoundary key={source} fallback={fallback}><Host.Provider value={host}><A2uiSurface surface={surface} /></Host.Provider></SurfaceBoundary></div>;
}
