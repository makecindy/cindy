import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight, Monitor, RefreshCw, Settings } from 'lucide-react';
import wordmarkLight from '../../native/menubar/wordmark-light.png';
import wordmarkDark from '../../native/menubar/wordmark-dark.png';
import type { MenubarView } from '../shared/menubarQuota';
import { QUOTA_PANEL_DESIGN } from '../shared/quotaPanelDesign';
import type { QuotaTrayBridge } from '../shared/quotaTray';
import { Chart, Logo, Manage, Detail, Usage, money, relative } from './quota-tray-pages';
import { CountUp, Tube } from './quota-tray-tube';
import './styles/quota-tray.css';

declare global { interface Window { quotaTray: QuotaTrayBridge } }
type Tab = 'tabUnread' | 'tabOngoing' | 'tabUsage';
const tabs: Tab[] = ['tabUnread', 'tabOngoing', 'tabUsage'];
/**
 * Longest the hidden card waits for fonts and images before it reports itself ready. A window
 * reloaded while hidden never paints, so `image.decode()` never settles there; waiting on it
 * unbounded left the card unable to open on hover (main shows it only after `painted`).
 */
const PREWARM_WAIT_MS = 1000;
/** Page slides last as long as the Swift panel's `Motion.page`. */
const PAGE_SLIDE_MS = 500;
let lastTab: Exclude<Tab, 'tabUnread'> | undefined;

function Card({ view, now, hidden }: { view: MenubarView; now: number; hidden: boolean }) {
  const s = view.strings;
  const design = view.presentation ?? QUOTA_PANEL_DESIGN;
  const short = screen.availHeight < design.metrics.shortScreenHeight;
  const limit = short ? design.metrics.rowsShort : design.metrics.rowsTall;
  const activities = view.activities ?? [];
  const unread = activities.filter(row => row.attention);
  const ongoing = activities.filter(row => row.phase === 'running' || row.phase === 'needs-interaction');
  const openingTab = unread.length ? 'tabUnread' : lastTab ?? (ongoing.length ? 'tabOngoing' : 'tabUsage');
  const [tab, selectTab] = useState<Tab>(openingTab);
  useLayoutEffect(() => {
    if (hidden) selectTab(openingTab);
  }, [hidden, openingTab]);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState('main');
  // The page being left stays mounted while it slides out, as both pages do in the Swift panel.
  const [leaving, setLeaving] = useState<string | null>(null);
  const [spins, setSpins] = useState(0);
  const inner = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const footer = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const isDetail = page.startsWith('detail:') && !!view.details[page.slice(7)];
  const currentPage = view.gate ? 'main' : page.startsWith('detail:') && !isDetail ? 'main' : page;
  const go = (next: string) => {
    if (next === currentPage) return;
    setLeaving(matchMedia('(prefers-reduced-motion: reduce)').matches ? null : currentPage);
    setPage(next);
  };
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), PAGE_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [leaving, page]);
  const measure = () => window.quotaTray.resize((inner.current?.offsetHeight ?? 0) + (header.current?.offsetHeight ?? 0) + (footer.current?.offsetHeight ?? 0));
  useLayoutEffect(() => {
    // Each page is its own element, so the observer follows the page on screen.
    const observer = new ResizeObserver(measure);
    for (const element of [inner.current, header.current, footer.current]) if (element) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [currentPage]);
  useLayoutEffect(() => {
    let cancelled = false;
    // Prewarm the real card, including font metrics, before revealing the window.
    const images = [...document.images].map(image => image.decode().catch(() => {}));
    const assets = Promise.all([document.fonts.ready, ...images]);
    void Promise.race([assets, new Promise(resolve => setTimeout(resolve, PREWARM_WAIT_MS))]).then(() => {
      if (cancelled) return;
      // Hidden Electron windows pause animation frames. Measure decoded assets
      // synchronously and send the final bounds before presentation readiness.
      measure();
      window.quotaTray.painted();
    });
    return () => { cancelled = true; };
  }, []);
  useLayoutEffect(() => { main.current?.scrollTo(0, 0); }, [currentPage]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() === 'o') window.quotaTray.openApp();
      else if (event.key === ',') go('manage');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const rows = tab === 'tabUsage' ? view.tasks.map(row => ({
    ...row, preview: [row.idleStatus, row.meta].filter(Boolean).join(' · '), time: money(view, row.value), pulse: false,
  })) : (tab === 'tabUnread' ? unread : ongoing).map(row => ({
    ...row, preview: row.status ? row.status + ' · ' + row.preview : row.preview,
    time: relative(view, row.lastActivityAtMs, now), pulse: row.phase === 'running',
  }));
  const daily = view.usage.scopes[view.settings.scope].daily.slice(-30);
  const style = Object.fromEntries(Object.entries(design.colors).map(([name, pair]) => ['--' + name, `light-dark(${pair[0]}, ${pair[1]})`])) as CSSProperties;
  const tubeHeight = short ? design.metrics.tubeShort : design.metrics.tubeTall;
  Object.assign(style, { '--tube-height': tubeHeight + 'px',
    '--ring-size': (short ? design.metrics.ringShort : design.metrics.ringTall) + 'px',
    '--tile-radius': design.metrics.tileRadius + 'px', '--panel-radius': design.metrics.panelRadius + 'px' });
  const mainPage = <>
    {view.remotelyControlled && <button className="remote" onClick={window.quotaTray.openRemoteControlSettings}><Monitor size={16}/>
      <span>{s.remoteControlTitle}<small>{view.remoteControllerNames?.join(' · ') || s.remoteControlBody}</small></span><ChevronRight size={14}/></button>}
    <div className="headline"><h1>{view.gate ? s.gateTitle : view.headlinePrimary}</h1>
      <p className="secondary" data-alert={!view.gate && view.headlineAlert}>{view.gate ? s.gateBody : view.headlineSecondary}</p></div>
    {!view.gate && <>
      <section className="sources">{view.sources.filter(source => source.fill !== null).map((source, index) =>
        <button key={source.id} className="source" style={{ animationDelay: (index * 60) + 'ms' }} aria-label={source.accessibilityLabel} onClick={() => go('detail:' + source.id)}>
          <b className="metric">{source.value ? <CountUp text={source.value} locale={view.locale} visible={!hidden} delay={index * 0.06}/> : source.valueLabel}<small>{source.valueUnit}</small></b>
          <Tube fill={source.fill ?? 0} index={index} active={source.active} visible={!hidden} height={tubeHeight} emphasized={source.emphasized} level={source.level}/>
          <Logo svg={source.logoSvg}/><span>{source.name}</span><small data-level={source.whenLevel}>{source.when}</small>
        </button>)}</section>
      {view.sources.filter(source => source.fill === null).map(source => <button className="unmeasured" key={source.id} onClick={() => go('detail:' + source.id)}>
        <Logo svg={source.logoSvg}/><span>{source.name}</span><small>{source.valueLabel}</small><ChevronRight size={14}/></button>)}
      <nav className="tabs">{tabs.map(key => {
        const count = key === 'tabUnread' ? unread.length : key === 'tabOngoing' ? ongoing.length : 0;
        return <button key={key} aria-pressed={key === tab} onClick={() => {
          selectTab(key); setExpanded(false); if (key !== 'tabUnread') lastTab = key;
        }}>{s[key]}{count > 0 && <small>{count}</small>}</button>;
      })}</nav>
      {tab === 'tabUsage' && <div className="section-caption task-summary"><small>{view.taskSummary}</small>
        <b className="metric">{money(view, view.tasks.reduce((total, row) => total + row.value, 0))}</b></div>}
      <section className="rows">{(expanded ? rows : rows.slice(0, limit)).map(row =>
        <button key={row.sessionId} className="task-row" onClick={() => window.quotaTray.openSession(row.sessionId)}>
          <span className="task-icon" data-running={row.pulse}><Logo svg={row.logoSvg}/></span>
          <span className="task-content"><span className="task-title"><strong>{row.title}</strong><small>{row.time}</small></span>
            <span className="task-preview">{row.preview}</span></span>
        </button>)}
        {!rows.length && <p className="empty">{s[tab === 'tabUnread' ? 'noUnread' : tab === 'tabOngoing' ? 'noOngoing' : 'noTasksToday']}</p>}
        {rows.length > limit && <button className="more" onClick={() => setExpanded(!expanded)}>
          <span>{s[expanded ? 'collapseTasks' : 'allTasks']}</span><span>{rows.length}<ChevronRight size={14}/></span></button>}
      </section>
      <button className="usage tile" onClick={() => go('usage')} aria-label={s.expandUsage}>
        <span><small>{s[view.settings.scope === 'all' ? 'monthScopeAll' : 'monthScopeLocal']}</small>
          <b className="metric"><CountUp text={money(view, daily.reduce((sum, day) => sum + day.money.reduce((a, b) => a + b, 0), 0))} locale={view.locale} visible={!hidden} delay={0.2}/></b></span>
        <Chart daily={daily}/><span className="expand">{s.expand}<ArrowUpRight size={14}/></span>
      </button>
    </>}
  </>;
  const body = (which: string) => which === 'manage' ? <Manage view={view}/> : which === 'usage' ? <Usage view={view}/> :
    which.startsWith('detail:') ? <Detail view={view} id={which.slice(7)}/> : mainPage;
  return <div className="panel" data-visible={!hidden} style={style}>
    <header ref={header}>
      {currentPage === 'main' ? <><picture><source media="(prefers-color-scheme: dark)" srcSet={wordmarkDark}/><img className="wordmark" src={wordmarkLight} alt="Cindy"/></picture>
        <small>{relative(view, view.updatedAtMs, now, true)}</small>
        <button className="refresh icon-button" aria-label={s.refresh} onClick={() => { setSpins(spins + 1); window.quotaTray.refresh(); }}>
          <RefreshCw size={16} style={{ rotate: (spins * 360) + 'deg' }}/></button></> :
        <><button className="icon-button" aria-label={s.back} onClick={() => go('main')}><ArrowLeft size={16}/></button>
          <b>{currentPage === 'manage' ? s.manageTitle : currentPage === 'usage' ? s.usageTitle : view.details[page.slice(7)]?.title}</b>
          {currentPage === 'manage' && <button className="done primary" onClick={() => go('main')}>{s.done}</button>}</>}
    </header>
    <main ref={main}>
      {leaving && leaving !== currentPage && <div key={leaving} className="page" data-kind={leaving === 'main' ? 'main' : 'sub'} data-leaving inert>{body(leaving)}</div>}
      <div key={currentPage} ref={inner} className="page" data-kind={currentPage === 'main' ? 'main' : 'sub'} data-returning={leaving !== null}>{body(currentPage)}</div>
    </main>
    <footer ref={footer} hidden={currentPage !== 'main'}>
      <button className="primary open-app" onClick={window.quotaTray.openApp}>
        <svg viewBox="0 0 1 1" aria-hidden="true"><polygon points="0,0 1,.4354 1,.5636 0,1 0,.6551 .352,.4995 0,.3442"/></svg>
        {s.openApp}<kbd>Ctrl O</kbd>
      </button>
      {!view.gate && <button className="icon-button" aria-label={s.settings} onClick={() => go('manage')}><Settings size={17}/></button>}
    </footer>
  </div>;
}

export function QuotaTray() {
  const [view, setView] = useState<MenubarView | null>(null);
  const [generation, setGeneration] = useState(0);
  const [hidden, setHidden] = useState(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const unsubscribe = window.quotaTray.subscribe(setView);
    const offHidden = window.quotaTray.onWindowHiddenChange(hidden => {
      setHidden(hidden);
      if (hidden) setGeneration(value => value + 1);
    });
    window.quotaTray.ready();
    return () => { unsubscribe(); offHidden(); };
  }, []);
  useEffect(() => {
    if (!view) return;
    document.documentElement.lang = view.locale;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [!!view]);
  return view ? <Card key={generation} view={view} now={now} hidden={hidden}/> : <header aria-busy="true"><strong>CINDY.</strong><progress/></header>;
}
