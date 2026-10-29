import {
  Mail,
  CalendarDays,
  Folder,
  ChartColumn,
  Check,
  Info,
  Clock,
  MapPin,
  Coffee,
  Image,
  Users,
  Star,
} from 'lucide-react';
import {
  Fragment,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  useMemo,
  useRef,
  useState,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  richVisualStyle,
  richColor,
  richVector,
  RichAnswerStream,
  RichInteractionMemory,
  RichSubmissionController,
  richSendText,
  richAction,
  richChart,
  richLinePlot,
  richResolvedValues,
  richCalculationUnavailable,
  richLabel,
  richMarkdown,
  richNumber,
  richOptions,
  richRange,
  richString,
  type RichNode,
  type RichPalette,
  type RichValue,
} from '@cindy/maker-shared/rich-answer';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { useSessionQuickSend } from './SessionQuickSendContext';
import './rich-answer.css';

/** Answer colors are Cindy theme tokens, so they follow the mode without re-rendering. */
const palette: RichPalette = {
  primary: 'var(--text-primary)',
  secondary: 'var(--text-secondary)',
  tertiary: 'var(--text-tertiary)',
  success: 'var(--status-success)',
  warning: 'var(--warning-fg)',
  danger: 'var(--error-fg)',
  border: 'var(--border-default)',
};
const answerIcons = {
  mail: Mail,
  calendar: CalendarDays,
  folder: Folder,
  chart: ChartColumn,
  check: Check,
  info: Info,
  clock: Clock,
  location: MapPin,
  coffee: Coffee,
  image: Image,
  users: Users,
  star: Star,
};

const memory = new RichInteractionMemory({
  async read() {
    return localStorage.getItem('cindy.richAnswer.viewState.v1');
  },
  writeSync(value) {
    localStorage.setItem('cindy.richAnswer.viewState.v1', value);
  },
  async write(value) {
    localStorage.setItem('cindy.richAnswer.viewState.v1', value);
  },
});
const submissions = new RichSubmissionController(memory);

function RichSendAction({ node, text, receiptKey, ready, style }: {
  node: RichNode; text: string | undefined; receiptKey: string; ready: boolean;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const sender = useSessionQuickSend();
  const status = useSyncExternalStore(submissions.subscribe, () => submissions.status(receiptKey, text));
  const disabled = !ready || !sender || !text || status === 'sending' || status === 'sent';
  return <div className="rich-answer-layout rich-answer-stack" style={style}>
    {text && <p className="rich-answer-caption" style={{ whiteSpace: 'pre-wrap' }}>{text}</p>}
    <Button type="button" variant="secondary" disabled={disabled}
      onClick={() => { if (!disabled) void submissions.submit(receiptKey, text, value => sender.send(value, { literalText: true, independent: true })); }}>
      {status === 'sending' ? t('richAnswer.sending') : status === 'sent' ? t('richAnswer.sent') : richString(node, 'label', richString(node, 'text')) || t('richAnswer.send')}
    </Button>
    {status === 'failed' && <p className="rich-answer-caption" role="alert">{t('richAnswer.sendFailed')}</p>}
  </div>;
}
/** Component identities and user input survive content patches; no generated HTML executes. */
export function RichAnswer({
  source,
  complete,
  stateKey,
  renderMarkdown,
  renderMedia,
}: {
  source: string;
  complete: boolean;
  stateKey: string;
  renderMedia?: (node: RichNode) => ReactNode;
  renderMarkdown: (source: string, id: string) => ReactNode;
}) {
  const { user } = useAuth();
  return (
    <RichAnswerDocument
      key={`${user?.id ?? 'signed-out'}:${stateKey}`}
      source={source}
      complete={complete}
      stateKey={`${user?.id ?? 'signed-out'}:${stateKey}`}
      renderMarkdown={renderMarkdown}
      renderMedia={renderMedia}
    />
  );
}
function RichAnswerDocument({
  source,
  complete,
  stateKey,
  renderMarkdown,
  renderMedia,
}: {
  source: string;
  complete: boolean;
  stateKey: string;
  renderMedia?: (node: RichNode) => ReactNode;
  renderMarkdown: (source: string, id: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const parser = useRef(new RichAnswerStream());
  const doc = useMemo(() => parser.current.update(source, complete), [source, complete]);
  const edited = useSyncExternalStore(memory.subscribe, () => memory.get(stateKey));
  useEffect(() => {
    void memory.load();
    const save = () => memory.flushSync();
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      void memory.flush();
    };
  }, []);
  const values = richResolvedValues(doc, edited);
  const change = (key: string, v: RichValue) => memory.set(stateKey, { [key]: v });
  const apply = (node: RichNode) => memory.set(stateKey, richAction(node, values));
  const render = (id: string): ReactNode => {
    const node = doc.nodes.get(id);
    if (!node) return null;
    const result = renderContent(id),
      visual = richVisualStyle(node, palette);
    if (!isValidElement(result) || !Object.keys(visual).length) return result;
    const element = result as ReactElement<{ style?: CSSProperties }>;
    const media = ['image', 'video', 'audio'].includes(node.kind);
    const box = { ...visual };
    if (media) for (const key of ['height', 'minHeight', 'maxHeight']) delete box[key];
    // The same answer is read on phones: fixed widths never exceed the available width.
    if (typeof box.width === 'number' && box.maxWidth === undefined) box.maxWidth = '100%';
    if (typeof box.minWidth === 'number') box.minWidth = `min(${box.minWidth}px, 100%)`;
    const variables: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(visual))
      variables[`--rich-${key}`] =
        typeof value === 'number' &&
        !['fontWeight', 'opacity', 'flexGrow', 'flexShrink'].includes(key) &&
        !(key === 'lineHeight' && value <= 4)
          ? `${value}px`
          : value;
    return cloneElement(element, {
      style: {
        ...element.props.style,
        ...box,
        lineHeight:
          typeof visual.lineHeight === 'number' && visual.lineHeight > 4
            ? `${visual.lineHeight}px`
            : visual.lineHeight,
        ...variables,
      } as CSSProperties,
    });
  };
  const renderContent = (id: string): ReactNode => {
    const node = doc.nodes.get(id);
    if (!node) return null;
    if (richCalculationUnavailable(node, values))
      return (
        <p className="rich-answer-caption" role="status">
          {complete ? t('richAnswer.calculationUnavailable') : '…'}
        </p>
      );
    const bind = richString(node, 'bind', id),
      label = richString(node, 'label');
    const children = node.children.map((child) => <Fragment key={child}>{render(child)}</Fragment>);
    if (['image', 'video', 'audio'].includes(node.kind) && renderMedia)
      return (
        <div className="rich-answer-content rich-answer-media">
          {renderMedia(node)}
          {richString(node, 'caption') && (
            <div className="rich-answer-caption">{richString(node, 'caption')}</div>
          )}
        </div>
      );
    const md = richMarkdown(node);
    if (md !== null)
      return (
        <div data-rich-node={id} className="rich-answer-content">
          {renderMarkdown(md, id)}
          {richString(node, 'caption') && (
            <div className="rich-answer-caption">{richString(node, 'caption')}</div>
          )}
        </div>
      );
    switch (node.kind) {
      case 'svg': {
        const vector = richVector(node, palette);
        return (
          <svg
            role="img"
            aria-label={label || richString(node, 'alt')}
            viewBox={vector.viewBox}
            // Unpainted shapes take the host text color instead of SVG's default black.
            style={{ width: '100%', height: 'auto', display: 'block', fill: 'currentColor' }}
          >
            {vector.shapes.map(({ type, props: { fill, stroke, ...props }, text }, index) =>
              // Theme tokens only resolve as CSS, not as SVG presentation attributes.
              createElement(type, { ...props, style: { fill, stroke }, key: index }, text),
            )}
          </svg>
        );
      }
      case 'heading':
        return <h3 className="rich-answer-heading">{richLabel(node, values)}</h3>;
      case 'text':
        return <p className="rich-answer-text">{richLabel(node, values)}</p>;
      case 'icon': {
        const name = richString(node, 'name');
        const Icon = Object.prototype.hasOwnProperty.call(answerIcons, name)
          ? answerIcons[name as keyof typeof answerIcons]
          : Info;
        return (
          <div className="rich-answer-icon-row">
            <Icon
              size={richNumber(node, 'size', 20)}
              strokeWidth={richNumber(node, 'strokeWidth', 1.75)}
              aria-hidden="true"
            />
            <div>
              <strong>{label || name}</strong>
              {richString(node, 'text') && (
                <p className="rich-answer-text">{richString(node, 'text')}</p>
              )}
            </div>
          </div>
        );
      }
      case 'divider':
        return <hr className="rich-answer-divider" />;
      case 'stack':
      case 'row':
      case 'grid':
      case 'group':
        return (
          <div
            data-rich-node={id}
            className={`rich-answer-layout rich-answer-${node.kind}${Array.isArray(node.props.weights) ? ' rich-answer-grid' : ''}${richString(node, 'layout') === 'aside' ? ' rich-answer-aside' : ''}`}
            style={
              {
                '--rich-mobile-columns': richNumber(node, 'mobileColumns', 1),
                '--rich-ratio': Array.isArray(node.props.weights)
                  ? node.props.weights
                      .filter((v) => typeof v === 'number' && v > 0)
                      .map((v) => `minmax(0, ${v}fr)`)
                      .join(' ')
                  : undefined,
                '--rich-columns': Math.round(Math.max(1, richNumber(node, 'columns', 2))),
              } as CSSProperties
            }
          >
            {children}
          </div>
        );
      case 'stat':
        return (
          <div className="rich-answer-stat">
            <div className="rich-answer-caption">{label}</div>
            <output>{richLabel(node, values)}</output>
          </div>
        );
      case 'range': {
        const range = richRange(node, values[bind]);
        return (
          <div className="rich-answer-control">
            <div className="rich-answer-control-label">
              <span>{label}</span>
              <output>
                {range.value}
                {richString(node, 'suffix')}
              </output>
            </div>
            <Slider
              aria-label={label}
              min={range.min}
              max={range.max}
              step={range.step}
              value={[range.value]}
              onValueChange={(v) => change(bind, v[0])}
            />
          </div>
        );
      }
      case 'input':
        return (
          <label className="rich-answer-control">
            {label}
            <Input
              aria-label={label}
              value={String(values[bind] ?? '')}
              placeholder={richString(node, 'placeholder')}
              maxLength={4096}
              onChange={(value) => change(bind, value)}
            />
          </label>
        );
      case 'check':
        return (
          <label className="rich-answer-check">
            <input
              type="checkbox"
              checked={Boolean(values[bind])}
              onChange={(event) => change(bind, event.target.checked)}
            />
            <span>{label || richString(node, 'text')}</span>
          </label>
        );
      case 'select':
        return (
          <label className="rich-answer-control">
            {label}
            <select
              className="rich-answer-select"
              value={String(values[bind] ?? '')}
              onChange={(event) => change(bind, event.target.value)}
            >
              <option value="" disabled>
                {richString(node, 'placeholder', label)}
              </option>
              {richOptions(node).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        );
      case 'button':
        if (Object.prototype.hasOwnProperty.call(node.props, 'send'))
          return <RichSendAction node={node} text={richSendText(node, values)} receiptKey={`${stateKey}:sent:${id}`} ready={complete && !doc.issues} />;
        return (
          <Button type="button" variant="secondary" tone="quiet" onClick={() => apply(node)}>
            {label || richString(node, 'text')}
          </Button>
        );
      case 'form':
        if (Object.prototype.hasOwnProperty.call(node.props, 'send'))
          return <div className="rich-answer-layout rich-answer-stack">{children}<RichSendAction node={node} text={richSendText(node, values)} receiptKey={`${stateKey}:sent:${id}`} ready={complete && !doc.issues} /></div>;
        return (
          <form
            className="rich-answer-layout rich-answer-stack"
            onSubmit={(event) => {
              event.preventDefault();
              apply(node);
            }}
          >
            {children}
            {label && (
              <Button type="submit" variant="secondary">
                {label}
              </Button>
            )}
          </form>
        );
      case 'details':
        return (
          <details
            open={Boolean(values[bind])}
            onToggle={(event) => {
              if (Boolean(values[bind]) !== event.currentTarget.open)
                change(bind, event.currentTarget.open);
            }}
          >
            <summary>{label}</summary>
            <div className="rich-answer-layout rich-answer-stack">{children}</div>
          </details>
        );
      case 'tabs': {
        const selected = node.children.includes(String(values[bind]))
          ? String(values[bind])
          : node.children[0];
        return (
          <div>
            <div className="rich-answer-tabs" role="tablist" aria-label={label}>
              {node.children.map((child) => (
                <Button
                  key={child}
                  role="tab"
                  aria-selected={selected === child}
                  variant="secondary"
                  tone="quiet"
                  onClick={() => change(bind, child)}
                >
                  {richString(doc.nodes.get(child)!, 'label', child)}
                </Button>
              ))}
            </div>
            {node.children.map((child) => (
              <div key={child} role="tabpanel" hidden={selected !== child}>
                {render(child)}
              </div>
            ))}
          </div>
        );
      }
      case 'chart': {
        const data = richChart(node, values),
          min = Math.min(0, ...data.map((item) => item.value)),
          max = Math.max(0, ...data.map((item) => item.value)),
          span = max - min || 1;
        return (
          <figure className="rich-answer-chart">
            <figcaption>{label}</figcaption>
            {richString(node, 'variant') === 'line' ? (
              <AnswerLineChart
                data={data}
                label={label}
                node={node}
                color={richColor(node.props.color, palette)}
              />
            ) : null}
            {richString(node, 'variant') !== 'line' && (
              <dl>
                {data.map((item, i) => (
                  <div key={i}>
                    <div className="rich-answer-control-label">
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                    {richString(node, 'variant') !== 'line' && (
                      <div className="rich-answer-track">
                        <div
                          style={{
                            backgroundColor:
                              richColor((node.props.colors as unknown[])?.[i], palette) ??
                              richColor(node.props.color, palette),
                            marginLeft: `${((Math.min(0, item.value) - min) / span) * 100}%`,
                            width: `${(Math.abs(item.value) / span) * 100}%`,
                          }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </dl>
            )}
          </figure>
        );
      }
      default:
        return null;
    }
  };
  return (
    <div className="rich-answer" data-rich-answer>
      {doc.roots.map((id) => (
        <Fragment key={id}>{render(id)}</Fragment>
      ))}
      {doc.issues > 0 && (
        <p className="rich-answer-caption" role="status">
          {t('richAnswer.incomplete')}
        </p>
      )}
    </div>
  );
}

function AnswerLineChart({
  data,
  label,
  node,
  color = 'currentColor',
}: {
  data: { label: string; value: number }[];
  label: string;
  node: RichNode;
  color?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const plot = richLinePlot(data, width, node.props);
  return (
    <div ref={ref}>
      <svg
        role="img"
        aria-label={`${label}. ${data.map((item) => `${item.label}: ${item.value}`).join(', ')}`}
        viewBox={`0 0 ${plot.width} ${plot.height}`}
        style={{ height: plot.height, maxHeight: 'none' }}
      >
        {plot.ticks.map((tick) => (
          <Fragment key={tick.value}>
            {node.props.showGrid !== false && (
              <line
                x1={plot.left}
                x2={plot.width - plot.right}
                y1={tick.y}
                y2={tick.y}
                className="rich-answer-chart-guide"
              />
            )}
            <text
              x={plot.left - 6}
              y={tick.y + 4}
              textAnchor="end"
              className="rich-answer-chart-axis"
            >
              {tick.label}
            </text>
          </Fragment>
        ))}
        <polyline
          style={{ fill: 'none', stroke: color }}
          strokeWidth={richNumber(node, 'strokeWidth', 2)}
          points={plot.points.map((p) => `${p.x},${p.y}`).join(' ')}
        />
        {plot.labels.map((tick, i) => (
          <text
            key={`label-${i}`}
            x={tick.x}
            y={plot.labelY}
            textAnchor="middle"
            className="rich-answer-chart-axis"
          >
            {tick.label}
          </text>
        ))}
        {plot.points.map((p, i) => (
          <Fragment key={i}>
            {node.props.showPoints !== false && (
              <circle
                cx={p.x}
                cy={p.y}
                r={richNumber(node, 'pointRadius', 3)}
                style={{ fill: color }}
              />
            )}
            {plot.showValues && (
              <text x={p.x} y={p.y - 10} textAnchor="middle" className="rich-answer-chart-value">
                {p.value}
              </text>
            )}
          </Fragment>
        ))}
      </svg>
    </div>
  );
}
