import { useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight } from 'lucide-react';
import type { MenubarView, MenubarUsageScopeData } from '../shared/menubarQuota';
import { CINDY_MARK_PATH, CINDY_MARK_TRANSFORM } from '@cindy/model-providers/branding';

export function text(view: MenubarView, key: string, values: Record<string, string | number> = {}): string {
  const n = values.n;
  const plural = typeof n === 'number' ? new Intl.PluralRules(view.locale).select(n) : '';
  const template = view.strings[key + '_' + plural] ?? view.strings[key] ?? view.strings[key + '_other'] ?? '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ''));
}

export function money(view: MenubarView, value: number): string {
  return view.moneySymbol + (value >= 10_000 ? (value / 1000).toFixed(1) + 'k' :
    new Intl.NumberFormat(view.locale, { maximumFractionDigits: value < 100 ? 2 : 0 }).format(value));
}

export function relative(view: MenubarView, time: number | null, now: number, updated = false): string {
  if (!time) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (!minutes) return text(view, updated ? 'updatedJustNow' : 'activityNow');
  const key = minutes < 60 ? 'Minutes' : minutes < 1440 ? 'Hours' : 'Days';
  const n = Math.floor(minutes / (minutes < 60 ? 1 : minutes < 1440 ? 60 : 1440));
  return text(view, (updated ? 'updated' : 'activity') + key, { n });
}

export function Logo({ svg }: { svg: string }) {
  const document = svg === 'cindy:mark'
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path transform="${CINDY_MARK_TRANSFORM}" d="${CINDY_MARK_PATH}"/></svg>`
    : svg;
  // Image documents cannot execute scripts or navigate the app, unlike inline SVG markup.
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(document);
  return <span className="logo" aria-hidden="true" style={{ maskImage: `url("${url}")` }}/>;
}

export function Chart({ daily, onSelect }: {
  daily: MenubarUsageScopeData['daily']; onSelect?: (index: number | null) => void;
}) {
  const totals = daily.map(day => day.money.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const points = (series: number[]) => series.map((value, i) =>
    `${i * 100 / Math.max(1, series.length - 1)},${29 - 27 * value / max}`);
  return <svg className="chart" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"
    onMouseLeave={() => onSelect?.(null)} onMouseMove={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      onSelect?.(Math.min(daily.length - 1, Math.max(0, Math.round((event.clientX - bounds.left) / bounds.width * (daily.length - 1)))));
    }}>
    {['claude', 'codex', 'pi'].map((name, index) => {
      const lower = daily.map(day => day.money.slice(0, index).reduce((a, b) => a + b, 0));
      const upper = daily.map((day, i) => lower[i] + day.money[index]);
      return <polygon key={name} className={name} points={[...points(upper), ...points(lower).reverse()].join(' ')}/>;
    })}
    <polyline points={points(totals).join(' ')} fill="none" stroke="currentColor" strokeWidth=".6"/>
  </svg>;
}

export function Manage({ view }: { view: MenubarView }) {
  const s = view.strings;
  const bridge = window.quotaTray;
  // The last visible source cannot be hidden, as in the Swift panel: its switch shakes instead.
  const [shaking, setShaking] = useState<{ id: string; at: number } | null>(null);
  const toggle = (id: string, visible: boolean) => !visible && view.manage.filter(row => !row.hidden).length <= 1
    ? setShaking({ id, at: Date.now() }) : bridge.updateSettings({
    hidden: visible ? view.settings.hidden.filter(item => item !== id) : [...view.settings.hidden, id],
    shown: visible ? [...view.settings.shown, id] : view.settings.shown.filter(item => item !== id),
  });
  const move = (id: string, delta: number) => {
    const order = view.manage.map(row => row.id);
    const index = order.indexOf(id);
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    bridge.updateSettings({ order: [...order, ...view.settings.order.filter(item => !order.includes(item))] });
  };
  return <div className="manage">
    <div className="section-caption"><b>{s.sources}</b><small>{text(view, 'sourcesShown', {
      a: view.manage.filter(row => !row.hidden).length, b: view.manage.length,
    })}</small></div>
    <section className="tile">{view.manage.map((row, index) =>
      <div className="manage-source" key={row.id}>
        <Logo svg={row.logoSvg}/><label><strong>{row.title}</strong><small>{row.subtitle}</small>
          <input type="checkbox" checked={!row.hidden} aria-label={text(view, 'showSource', { name: row.title })}
            key={shaking?.id === row.id ? shaking.at : undefined} data-shake={shaking?.id === row.id}
            onChange={event => toggle(row.id, event.target.checked)}/></label>
        <div className="reorder">
          <button disabled={!index} aria-label={s.moveUp} onClick={() => move(row.id, -1)}><ArrowUp size={14}/></button>
          <button disabled={index === view.manage.length - 1} aria-label={s.moveDown} onClick={() => move(row.id, 1)}><ArrowDown size={14}/></button>
        </div>
      </div>)}</section>
    <h2>{s.other}</h2>
    <section className="tile">
      {(['lowAlert', 'privacy'] as const).map(key => <label className="setting" key={key}>{s[key]}
        <input type="checkbox" role="switch" checked={view.settings[key]}
          onChange={event => bridge.updateSettings({ [key]: event.target.checked })}/></label>)}
      <label className="setting scope">{s.usageScope}
        <select value={view.settings.scope} onChange={event => bridge.updateSettings({ scope: event.target.value as 'all' | 'local' })}>
          <option value="local">{s.scopeLocal}</option><option value="all">{s.scopeAll}</option>
        </select></label>
    </section>
    <button className="manage-foot" onClick={bridge.openProviderSettings}>{s.manageFoot}<ArrowUpRight size={14}/></button>
  </div>;
}

/**
 * The rings draw once the page has all but arrived. Started together with the slide, as the
 * Swift panel starts them, most of the arc is drawn while the page is still off to the side.
 */
const RING_START_MS = 250;

export function Detail({ view, id }: { view: MenubarView; id: string }) {
  const detail = view.details[id];
  if (!detail) return null;
  return <div className="detail">
    <Logo svg={detail.logoSvg}/><h1>{detail.title}</h1><p className="secondary">{detail.plan}</p>
    <div className="rings">
      <svg viewBox="0 0 200 200" aria-hidden="true">{detail.rings.map((ring, i) =>
        <g key={i}><circle cx="100" cy="100" r={90 - i * 12} className="ring-track"/>
          <circle cx="100" cy="100" r={90 - i * 12} pathLength="1" strokeDasharray={`${ring.fraction} 1`}
            transform="rotate(-90 100 100)" style={{ stroke: `var(--${ring.color})`, animationDelay: (RING_START_MS + i * 60) + 'ms' }}/></g>)}</svg>
      <div><b className="metric" style={{ color: detail.bigColor ? `var(--${detail.bigColor})` : undefined }}>{detail.bigValue}<small>{detail.bigUnit}</small></b><small>{detail.bigCaption}</small></div>
    </div>
    <div className="legend">{detail.legend.map((item, i) => <small key={i}><i style={{ background: `var(--${item.color})` }}/>{item.label}</small>)}</div>
    <h2>{detail.sayPrimary}</h2><p className="secondary">{detail.saySecondary}</p>
    <div className="facts">{detail.facts.map((fact, i) => <div className="tile" key={i}>
      <small>{fact.label}</small><strong>{fact.value}</strong><small>{fact.sub}</small>
    </div>)}</div>
    {detail.action.kind !== 'none' && <button className="primary" onClick={() => window.quotaTray.detailAction(id)}>{detail.actionLabel}</button>}
  </div>;
}

export function Usage({ view }: { view: MenubarView }) {
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const [selected, setSelected] = useState<number | null>(null);
  const [list, setList] = useState<'models' | 'tasks'>('models');
  const scope = view.usage.scopes[view.settings.scope];
  const daily = scope.daily.slice(-range);
  const dates = view.usage.days.slice(-range);
  const shown = selected === null ? daily : daily.slice(selected, selected + 1);
  const total = shown.reduce((sum, day) => sum + day.money.reduce((a, b) => a + b, 0), 0);
  return <div className="usage-page">
    <nav className="range">{([7, 30, 90] as const).map(n => <button key={n} aria-pressed={range === n}
      onClick={() => { setRange(n); setSelected(null); }}>{view.strings['range' + n]}</button>)}</nav>
    <b className="usage-total metric">{money(view, total)}</b>
    <p className="secondary">{selected === null ? text(view, 'wideCaptionMoney', { n: range }) : dates[selected]}</p>
    <small>{view.strings[view.settings.scope === 'all' ? 'scopeAll' : 'scopeLocal']} · {view.strings.dailyAverage} {money(view, total / Math.max(1, shown.length))}</small>
    <p className="secondary"><small>{view.strings.paid} {money(view, shown.reduce((sum, day) => sum + day.paid, 0))} · {
      new Intl.NumberFormat(view.locale, { notation: 'compact' }).format(shown.reduce((sum, day) => sum + day.tokens.reduce((a, b) => a + b, 0), 0))
    } {view.strings.tokenUnit}</small></p>
    <Chart daily={daily} onSelect={setSelected}/>
    <div className="section-caption"><small>{dates[0]}</small><small>{view.strings.today}</small></div>
    <div className="tile">{(['claude-code', 'codex', 'pi'] as const).map((harness, index) => <div className="setting" key={harness}>
      <span>{view.strings['harness.' + harness]}</span><b>{money(view, shown.reduce((a, day) => a + day.money[index], 0))}</b>
    </div>)}</div>
    <nav className="tabs">
      <button aria-pressed={list === 'models'} onClick={() => setList('models')}>{text(view, 'listModels', { n: range })}</button>
      <button aria-pressed={list === 'tasks'} onClick={() => setList('tasks')}>{view.strings.listTasks}</button>
    </nav>
    {list === 'tasks' && !view.tasks.length && <p className="empty">{view.strings.noTasksToday}</p>}
    {list === 'tasks' ? [...view.tasks].sort((a, b) => b.value - a.value).map(task =>
      <button key={task.sessionId} className="task-row" onClick={() => window.quotaTray.openSession(task.sessionId)}>
        <span className="task-icon"><Logo svg={task.logoSvg}/></span>
        <span className="task-content"><span className="task-title"><strong>{task.title}</strong><small>{money(view, task.value)}</small></span>
          <span className="task-preview">{[task.running ? view.strings.running : task.idleStatus, task.meta].filter(Boolean).join(' · ')}</span></span>
      </button>) : scope.models[String(range) as '7' | '30' | '90'].slice(0, 5).map((model, i) => <div className="setting" key={i}>
      <span>{model.name}</span><b>{money(view, model.money)}</b>
    </div>)}
    <p className="secondary">{scope.note}</p>
  </div>;
}
