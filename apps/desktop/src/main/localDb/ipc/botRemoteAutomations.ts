import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Schedule } from '@cindy/maker-scheduler';
import { resolveRemoteText, type RemoteActionInvokeResponse, type RemoteLocalizedText, type RemoteResource } from '@cindy/device-link';
import { cronToHuman } from '../../../shared/scheduleCronLabel.js';
import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import type { createBotRemoteSettingsResource } from './botRemoteSettingsResource.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

/** The scheduler calls the Automations page makes. */
export interface BotRemoteAutomationService {
  /** This teammate's project folder on this computer. */
  workspace(botId: string): string;
  list(): Promise<Schedule[]>;
  inflight(scheduleId: string): Promise<number>;
  /** Same as the Automations page: also clears the paused automation's unread results. */
  pause(scheduleId: string): Promise<unknown>;
  resume(scheduleId: string): Promise<unknown>;
}
export interface BotRemoteAutomationDeps {
  owner(): string;
  assertOwner(owner: string): void;
  automations: BotRemoteAutomationService;
}
export interface BotRemoteAutomationRequest {
  botId: string;
  botName: string;
  /** Schedule segment of `settings:<botId>/automations/<scheduleId>`; absent for the list. */
  scheduleId?: string;
  locale?: string;
}

/** The renderer strings the desktop teammate Automations page shows (renderer common.json), for the phone. */
const copy: Record<string, RemoteLocalizedText> = {
  'bots.automations.title': { fallback: "Automations", translations: {"zh-CN":"自动化","zh-TW":"自動化","ja":"自動化","ko":"자동화","es":"Automatizaciones","fr":"Automatisations","de":"Automatisierungen","pt-PT":"Automatizações","pt-BR":"Automações","zh-Hant-x-lzh":"自運","zh-Hans-x-lzh":"自运"} },
  'bots.automations.description': { fallback: "Automations in {{name}}'s project. Turn them on or off here; edit them in Automations.", translations: {"zh-CN":"{{name}} 项目里的自动化。在这里开关，编辑请到自动化页面。","zh-TW":"{{name}} 專案裡的自動化。在這裡開關，編輯請到自動化頁面。","ja":"{{name}} のプロジェクトの自動化です。ここでオン／オフを切り替え、編集は自動化ページで行います。","ko":"{{name}} 프로젝트의 자동화입니다. 여기서 켜고 끄며, 편집은 자동화 페이지에서 합니다.","es":"Automatizaciones del proyecto de {{name}}. Actívalas o desactívalas aquí; edítalas en Automatizaciones.","fr":"Automatisations du projet de {{name}}. Activez-les ou désactivez-les ici ; modifiez-les dans Automatisations.","de":"Automatisierungen im Projekt von {{name}}. Hier ein- oder ausschalten, bearbeiten unter Automatisierungen.","pt-PT":"Automatizações do projeto de {{name}}. Ative ou desative aqui; edite em Automatizações.","pt-BR":"Automações do projeto de {{name}}. Ative ou desative aqui; edite em Automações.","zh-Hant-x-lzh":"{{name}} 案中之自運。於此啟閉，修改請往自運之頁。","zh-Hans-x-lzh":"{{name}} 案中之自运。于此启闭，修改请往自运之页。"} },
  'bots.automations.empty': { fallback: "{{name}} has no automations yet.", translations: {"zh-CN":"{{name}} 还没有自动化。","zh-TW":"{{name}} 還沒有自動化。","ja":"{{name}} にはまだ自動化がありません。","ko":"{{name}}에게 아직 자동화가 없습니다.","es":"{{name}} aún no tiene automatizaciones.","fr":"{{name}} n'a pas encore d'automatisation.","de":"{{name}} hat noch keine Automatisierungen.","pt-PT":"{{name}} ainda não tem automatizações.","pt-BR":"{{name}} ainda não tem automações.","zh-Hant-x-lzh":"{{name}} 尚無自運。","zh-Hans-x-lzh":"{{name}} 尚无自运。"} },
  'bots.automations.toggle': { fallback: "Turn on “{{name}}”", translations: {"zh-CN":"启用「{{name}}」","zh-TW":"啟用「{{name}}」","ja":"「{{name}}」をオンにする","ko":"“{{name}}” 켜기","es":"Activar “{{name}}”","fr":"Activer « {{name}} »","de":"„{{name}}“ einschalten","pt-PT":"Ativar «{{name}}»","pt-BR":"Ativar “{{name}}”","zh-Hant-x-lzh":"啟「{{name}}」","zh-Hans-x-lzh":"启「{{name}}」"} },
  'scheduler.cell.subtitlePaused': { fallback: "Paused", translations: {"zh-CN":"已暂停","zh-TW":"已暫停","ja":"一時停止中","ko":"일시 중지됨","es":"En pausa","fr":"En pause","de":"Pausiert","pt-PT":"Em pausa","pt-BR":"Em pausa","zh-Hant-x-lzh":"已暫止","zh-Hans-x-lzh":"已暂止"} },
  'scheduler.cell.subtitleManual': { fallback: "Manual", translations: {"zh-CN":"手动","zh-TW":"手動","ja":"手動","ko":"수동","es":"manuales","fr":"Manuelle","de":"Manuell","pt-PT":"Manual","pt-BR":"Manual","zh-Hant-x-lzh":"手動","zh-Hans-x-lzh":"手动"} },
  'scheduler.cell.subtitleOnce': { fallback: "Once", translations: {"zh-CN":"一次","zh-TW":"一次","ja":"1回","ko":"1회","es":"Una vez","fr":"Ponctuelle","de":"Einmalig","pt-PT":"Uma vez","pt-BR":"Uma vez","zh-Hant-x-lzh":"一次","zh-Hans-x-lzh":"一次"} },
  'scheduler.webhook.title': { fallback: "Webhook trigger", translations: {"zh-CN":"Webhook 触发","zh-TW":"Webhook 觸發","ja":"Webhook トリガー","ko":"Webhook 트리거","es":"Activador de webhook","fr":"Déclencheur webhook","de":"Webhook-Auslöser","pt-PT":"Acionador de webhook","pt-BR":"Gatilho de webhook","zh-Hant-x-lzh":"Webhook 觸發","zh-Hans-x-lzh":"Webhook 触发"} },
  'scheduler.builtinTemplates.schedule.everyMinute': { fallback: "Every minute", translations: {"zh-CN":"每分钟","zh-TW":"每分鐘","ja":"毎分","ko":"매분","es":"Cada minuto","fr":"Toutes les minutes","de":"Jede Minute","pt-PT":"A cada minuto","pt-BR":"A cada minuto","zh-Hant-x-lzh":"每分","zh-Hans-x-lzh":"每分"} },
  'scheduler.builtinTemplates.schedule.hourlyAt': { fallback: "Hourly at minute {{minutes}}", translations: {"zh-CN":"每小时第 {{minutes}} 分","zh-TW":"每小時第 {{minutes}} 分","ja":"毎時 {{minutes}} 分","ko":"매시 {{minutes}}분","es":"Cada hora, en el minuto {{minutes}}","fr":"Toutes les heures à la minute {{minutes}}","de":"Stündlich zur Minute {{minutes}}","pt-PT":"A cada hora, ao minuto {{minutes}}","pt-BR":"A cada hora, no minuto {{minutes}}","zh-Hant-x-lzh":"每時第 {{minutes}} 分","zh-Hans-x-lzh":"每时第 {{minutes}} 分"} },
  'scheduler.builtinTemplates.schedule.atTimes': { fallback: "At {{times}}", translations: {"zh-CN":"{{times}}","zh-TW":"{{times}}","ja":"{{times}}","ko":"{{times}}","es":"A las {{times}}","fr":"À {{times}}","de":"Um {{times}}","pt-PT":"Às {{times}}","pt-BR":"Às {{times}}","zh-Hant-x-lzh":"{{times}}","zh-Hans-x-lzh":"{{times}}"} },
  'scheduler.builtinTemplates.schedule.atHoursMinutes': { fallback: "Hours {{hours}}, minutes {{minutes}}", translations: {"zh-CN":"{{hours}} 时的第 {{minutes}} 分","zh-TW":"{{hours}} 時的第 {{minutes}} 分","ja":"{{hours}} 時の {{minutes}} 分","ko":"{{hours}}시 {{minutes}}분","es":"Horas {{hours}}, minutos {{minutes}}","fr":"Heures {{hours}}, minutes {{minutes}}","de":"Stunden {{hours}}, Minuten {{minutes}}","pt-PT":"Horas {{hours}}, minutos {{minutes}}","pt-BR":"Horas {{hours}}, minutos {{minutes}}","zh-Hant-x-lzh":"{{hours}} 時之第 {{minutes}} 分","zh-Hans-x-lzh":"{{hours}} 时之第 {{minutes}} 分"} },
  'scheduler.builtinTemplates.schedule.monthDays': { fallback: "Days {{days}} of the month", translations: {"zh-CN":"每月 {{days}} 日","zh-TW":"每月 {{days}} 日","ja":"毎月 {{days}} 日","ko":"매월 {{days}}일","es":"Días {{days}} del mes","fr":"Jours {{days}} du mois","de":"An den Tagen {{days}} des Monats","pt-PT":"Dias {{days}} do mês","pt-BR":"Dias {{days}} do mês","zh-Hant-x-lzh":"每月 {{days}} 日","zh-Hans-x-lzh":"每月 {{days}} 日"} },
  'scheduler.builtinTemplates.schedule.daysOrWeekdays': { fallback: "{{days}} or {{weekdays}}", translations: {"zh-CN":"{{days}}或每周 {{weekdays}}","zh-TW":"{{days}}或每週 {{weekdays}}","ja":"{{days}} または毎週 {{weekdays}}","ko":"{{days}} 또는 매주 {{weekdays}}","es":"{{days}} o {{weekdays}}","fr":"{{days}} ou {{weekdays}}","de":"{{days}} oder {{weekdays}}","pt-PT":"{{days}} ou {{weekdays}}","pt-BR":"{{days}} ou {{weekdays}}","zh-Hant-x-lzh":"{{days}}或每週 {{weekdays}}","zh-Hans-x-lzh":"{{days}}或每周 {{weekdays}}"} },
  'scheduler.builtinTemplates.schedule.inMonths': { fallback: "In {{months}}", translations: {"zh-CN":"{{months}}","zh-TW":"{{months}}","ja":"{{months}}","ko":"{{months}}","es":"En {{months}}","fr":"En {{months}}","de":"In {{months}}","pt-PT":"Em {{months}}","pt-BR":"Em {{months}}","zh-Hant-x-lzh":"{{months}}","zh-Hans-x-lzh":"{{months}}"} },
  'scheduler.builtinTemplates.schedule.daily': { fallback: "Daily at {{time}}", translations: {"zh-CN":"每天 {{time}}","zh-TW":"每天 {{time}}","ja":"毎日 {{time}}","ko":"매일 {{time}}","es":"Todos los días a las {{time}}","fr":"Tous les jours à {{time}}","de":"Täglich um {{time}}","pt-PT":"Diariamente às {{time}}","pt-BR":"Diariamente às {{time}}","zh-Hant-x-lzh":"每日 {{time}}","zh-Hans-x-lzh":"每日 {{time}}"} },
  'scheduler.builtinTemplates.schedule.weekdays': { fallback: "Weekdays at {{time}}", translations: {"zh-CN":"工作日 {{time}}","zh-TW":"工作日 {{time}}","ja":"平日 {{time}}","ko":"평일 {{time}}","es":"De lunes a viernes a las {{time}}","fr":"En semaine à {{time}}","de":"Werktags um {{time}}","pt-PT":"Dias úteis às {{time}}","pt-BR":"Dias úteis às {{time}}","zh-Hant-x-lzh":"工作日 {{time}}","zh-Hans-x-lzh":"工作日 {{time}}"} },
  'scheduler.builtinTemplates.schedule.weekly': { fallback: "{{weekday}} at {{time}}", translations: {"zh-CN":"{{weekday}} {{time}}","zh-TW":"{{weekday}} {{time}}","ja":"{{weekday}} {{time}}","ko":"{{weekday}} {{time}}","es":"{{weekday}} a las {{time}}","fr":"{{weekday}} à {{time}}","de":"{{weekday}} um {{time}}","pt-PT":"{{weekday}} às {{time}}","pt-BR":"{{weekday}} às {{time}}","zh-Hant-x-lzh":"{{weekday}} {{time}}","zh-Hans-x-lzh":"{{weekday}} {{time}}"} },
  'scheduler.builtinTemplates.schedule.monthly': { fallback: "Monthly on day {{day}} at {{time}}", translations: {"zh-CN":"每月 {{day}} 日 {{time}}","zh-TW":"每月 {{day}} 日 {{time}}","ja":"毎月{{day}}日 {{time}}","ko":"매월 {{day}}일 {{time}}","es":"Cada mes, el día {{day}} a las {{time}}","fr":"Tous les mois le {{day}} à {{time}}","de":"Monatlich am {{day}}. um {{time}}","pt-PT":"Mensalmente no dia {{day}} às {{time}}","pt-BR":"Mensalmente no dia {{day}} às {{time}}","zh-Hant-x-lzh":"每月 {{day}} 日 {{time}}","zh-Hans-x-lzh":"每月 {{day}} 日 {{time}}"} },
  'scheduler.presentation.time.last': { fallback: "Last {{value}}", translations: {"zh-CN":"上次 {{value}}","zh-TW":"上次 {{value}}","ja":"前回 {{value}}","ko":"마지막 {{value}}","es":"Última vez: {{value}}","fr":"Dernière : {{value}}","de":"Zuletzt {{value}}","pt-PT":"Última {{value}}","pt-BR":"Últimos {{value}}","zh-Hant-x-lzh":"前次 {{value}}","zh-Hans-x-lzh":"前次 {{value}}"} },
  'scheduler.presentation.time.next': { fallback: "Next {{when}} (in {{interval}})", translations: {"zh-CN":"下次 {{when}}（{{interval}}后）","zh-TW":"下次 {{when}}（{{interval}}後）","ja":"次回 {{when}}（{{interval}}後）","ko":"다음 {{when}}（{{interval}} 후）","es":"Próxima ejecución: {{when}} (en {{interval}})","fr":"Prochaine : {{when}} (dans {{interval}})","de":"Nächste Ausführung {{when}} (in {{interval}})","pt-PT":"Próxima {{when}} (dentro de {{interval}})","pt-BR":"Próxima execução {{when}} (em {{interval}})","zh-Hant-x-lzh":"次回 {{when}}（{{interval}}後）","zh-Hans-x-lzh":"次回 {{when}}（{{interval}}后）"} },
  'scheduler.presentation.time.nextLessThanMinute': { fallback: "Next less than 1 min", translations: {"zh-CN":"下次不到 1 分钟","zh-TW":"下次不到 1 分鐘","ja":"次回は 1 分以内","ko":"다음 실행까지 1분 미만","es":"Próxima ejecución en menos de 1 min","fr":"Prochaine dans moins d'1 min","de":"Nächste Ausführung in weniger als 1 Min.","pt-PT":"Próxima em menos de 1 min","pt-BR":"Próxima execução em menos de 1 min","zh-Hant-x-lzh":"下次不及 1 分","zh-Hans-x-lzh":"下次不及 1 分"} },
  'scheduler.presentation.time.intervalMinutes': { fallback: "{{count}}m", translations: {"zh-CN":"{{count}}分钟","zh-TW":"{{count}}分鐘","ja":"{{count}}分","ko":"{{count}}분","es":"{{count}} min","fr":"{{count}} min","de":"{{count}} Min.","pt-PT":"{{count}}min","pt-BR":"{{count}}min","zh-Hant-x-lzh":"{{count}}分","zh-Hans-x-lzh":"{{count}}分"} },
  'scheduler.presentation.time.intervalHours': { fallback: "{{count}}h", translations: {"zh-CN":"{{count}}小时","zh-TW":"{{count}}小時","ja":"{{count}}時間","ko":"{{count}}시간","es":"{{count}} h","fr":"{{count}} h","de":"{{count}} Std.","pt-PT":"{{count}}h","pt-BR":"{{count}}h","zh-Hant-x-lzh":"{{count}}時","zh-Hans-x-lzh":"{{count}}时"} },
  'scheduler.presentation.time.intervalDays': { fallback: "{{count}}d", translations: {"zh-CN":"{{count}}天","zh-TW":"{{count}}天","ja":"{{count}}日","ko":"{{count}}일","es":"{{count}} d","fr":"{{count}} j","de":"{{count}} T.","pt-PT":"{{count}}d","pt-BR":"{{count}}d","zh-Hant-x-lzh":"{{count}}日","zh-Hans-x-lzh":"{{count}}日"} },
  'scheduler.confirm.pause.title': { fallback: "Pause automation \"{{name}}\"?", translations: {"zh-CN":"暂停自动化「{{name}}」？","zh-TW":"暫停自動化「{{name}}」？","ja":"自動化「{{name}}」を一時停止しますか？","ko":"자동화 \"{{name}}\"을(를) 일시중지하시겠습니까?","es":"¿Pausar la automatización \"{{name}}\"?","fr":"Mettre en pause l'automatisation « {{name}} » ?","de":"Automatisierung „{{name}}“ pausieren?","pt-PT":"Colocar a automatização \"{{name}}\" em pausa?","pt-BR":"Pausar a automação \"{{name}}\"?","zh-Hant-x-lzh":"暫止自運「{{name}}」？","zh-Hans-x-lzh":"暂止自运「{{name}}」？"} },
  'scheduler.confirm.pause.withInflight': { fallback: "This automation has {{count}} execution(s) currently in progress. Pausing will stop them immediately and in-progress work may be lost. Continue?", translations: {"zh-CN":"该自动化当前有 {{count}} 次执行正在进行。暂停将立即停止它们，已进行的工作可能被中断。是否继续？","zh-TW":"該自動化當前有 {{count}} 次執行正在進行。暫停將立即停止它們，已進行的工作可能被中斷。是否繼續？","ja":"この自動化は現在 {{count}} 件の実行が進行中です。一時停止すると直ちに停止され、進行中の作業が中断される可能性があります。続行しますか？","ko":"이 자동화에는 현재 {{count}}건의 실행이 진행 중입니다. 일시중지하면 즉시 중지되며 진행 중인 작업이 손실될 수 있습니다. 계속하시겠습니까?","es":"Esta automatización tiene {{count}} ejecución(es) en curso. Al pausarla, se detendrán de inmediato y podría perderse el trabajo en curso. ¿Continuar?","fr":"Cette automatisation a {{count}} exécution(s) en cours. La mise en pause les arrêtera immédiatement et le travail en cours pourrait être perdu. Continuer ?","de":"Diese Automatisierung hat {{count}} laufende Ausführung(en). Beim Pausieren werden sie sofort gestoppt und laufende Arbeit kann verloren gehen. Fortfahren?","pt-PT":"Esta automatização tem {{count}} execução(ões) em curso. A pausa irá interrompê-las imediatamente e o trabalho em curso poderá perder-se. Continuar?","pt-BR":"Esta automação tem {{count}} execução(ões) em andamento. A pausa irá interrompê-las imediatamente, e o trabalho em andamento poderá ser perdido. Continuar?","zh-Hant-x-lzh":"此自運今有 {{count}} 次方行。暫止則即停之，所行之事或將中斷。續乎？","zh-Hans-x-lzh":"此自运今有 {{count}} 次方行。暂止则即停之，所行之事或将中断。续乎？"} },
  'scheduler.confirm.pause.confirm': { fallback: "Pause", translations: {"zh-CN":"暂停","zh-TW":"暫停","ja":"一時停止","ko":"일시중지","es":"Pausar","fr":"Mettre en pause","de":"Pausieren","pt-PT":"Pausar","pt-BR":"Pausar","zh-Hant-x-lzh":"暫止","zh-Hans-x-lzh":"暂止"} },
};
export const automationsTitle = copy['bots.automations.title'];

const MS_MIN = 60_000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;
const pad = (value: number) => String(value).padStart(2, '0');
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
/** This computer's local time, as the desktop page: `14:23`, `04-30 14:23` or `2025-04-12 14:23`. */
function clock(at: number, now: number): string {
  const date = new Date(at);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (startOfDay(date) === startOfDay(new Date(now))) return time;
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()}-${day}`;
}

export function automationTiming(schedule: Schedule, locale: string | undefined, now = Date.now()) {
  const t = (key: string, values: Record<string, unknown> = {}) => resolveRemoteText(copy[key] ?? key, locale)
    .replace(/\{\{(\w+)\}\}/g, (match, name: string) => name in values ? String(values[name]) : match);
  const frequency = schedule.manual
    ? t(schedule.webhookTrigger ? 'scheduler.webhook.title' : 'scheduler.cell.subtitleManual')
    : schedule.recurring ? cronToHuman(schedule.cronExpr, t, locale ?? 'en') : t('scheduler.cell.subtitleOnce');
  if (schedule.status === 'paused') return { frequency, when: t('scheduler.cell.subtitlePaused') };
  const last = schedule.lastFiredAt ? t('scheduler.presentation.time.last', { value: clock(schedule.lastFiredAt, now) }) : null;
  let next: string | null = null;
  if (schedule.status === 'active' && !schedule.manual && schedule.nextFireAt) {
    const diff = schedule.nextFireAt - now;
    next = diff < MS_MIN ? t('scheduler.presentation.time.nextLessThanMinute') : t('scheduler.presentation.time.next', {
      when: clock(schedule.nextFireAt, now),
      interval: diff < MS_HOUR ? t('scheduler.presentation.time.intervalMinutes', { count: Math.floor(diff / MS_MIN) })
        : diff < MS_DAY ? t('scheduler.presentation.time.intervalHours', { count: Math.floor(diff / MS_HOUR) })
          : t('scheduler.presentation.time.intervalDays', { count: Math.floor(diff / MS_DAY) }),
    });
  }
  return { frequency, when: [last, next].filter(Boolean).join(' · ') };
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (id: string) => ({ collectionId: 'teammates', kind: 'bot', id });
const sameDir = (a: string, b: string) => {
  const left = path.resolve(a); const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/**
 * `settings:<botId>/automations[/<scheduleId>]`: the phone's view of the desktop teammate Automations page
 * (2026-11-10 owner): the teammate project's automations with their timing and an on/off switch.
 * Editing stays in the Automations page on the computer.
 */
export function createBotRemoteAutomationsEditor(deps: BotRemoteAutomationDeps, bind: ReturnType<typeof createBotRemoteSettingsResource>['bindResource']) {
  const read = async (owner: string, botId: string) => {
    const workspace = deps.automations.workspace(botId);
    const schedules = await deps.automations.list(); deps.assertOwner(owner);
    return schedules.filter(schedule => schedule.workspaceKind !== 'dialogue' && !!schedule.workingDir && sameDir(schedule.workingDir, workspace))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  return async (context: RemoteResourceHostContext, request: BotRemoteAutomationRequest): Promise<RemoteResource> => {
    const owner = deps.owner(); deps.assertOwner(owner);
    const { botId, botName, scheduleId, locale } = request;
    const id = `settings:${botId}/automations`;
    const items = await read(owner, botId);
    const state = (item: Schedule) => [item.id, item.status, item.name];
    const name = (key: string, values: Record<string, unknown>) => resolveRemoteText(copy[key], locale)
      .replace(/\{\{(\w+)\}\}/g, (match, field: string) => field in values ? String(values[field]) : match);
    if (!scheduleId) {
      if (!items.length) return { ref: ref(id), revision: hash(items), display: { title: copy['bots.automations.title'] }, links: [],
        blocks: [{ id: 'automations', primitive: 'markdown', fallbackMarkdown: name('bots.automations.empty', { name: botName }) }] };
      // One switch per automation, so a phone can list them with their timing and switch them in
      // place (2026-11-10 owner). Each row still links to its own page for clients that show rows.
      const inflight = await Promise.all(items.map(item => item.status === 'active' ? deps.automations.inflight(item.id) : Promise.resolve(0)));
      deps.assertOwner(owner);
      const running = items.filter((_, index) => inflight[index] > 0);
      const resource: RemoteResource = {
        ref: ref(id), revision: hash(items.map(state)), display: { title: copy['bots.automations.title'] }, links: [],
        blocks: [{ id: 'automations', primitive: 'form', title: copy['bots.automations.title'], fallbackMarkdown: name('bots.automations.description', { name: botName }),
          data: { actionId: 'automations', values: Object.fromEntries(items.map(item => [item.id, item.status === 'active'])),
            entries: items.map(item => {
              const { frequency, when } = automationTiming(item, locale);
              return { id: item.id, title: item.name, subtitle: [frequency, when].filter(Boolean).join(' · '), resourceId: `${id}/${item.id}` };
            }) } }],
        actions: [{ id: 'automations', label: copy['bots.automations.title'],
          fields: items.map(item => ({ id: item.id, label: item.name, kind: 'toggle' })),
          // Same as the Automations page: pausing stops runs in progress, so it asks first.
          ...(running.length ? { confirmation: {
            title: name('scheduler.confirm.pause.title', { name: running.map(item => item.name).join('、') }),
            body: name('scheduler.confirm.pause.withInflight', { count: inflight.reduce((sum, count) => sum + count, 0) }),
            confirmLabel: copy['scheduler.confirm.pause.confirm'],
          } } : {}) }],
      };
      return bind(context, resource, async () => hash((await read(owner, botId)).map(state)), async invoke => {
        const input = invoke.input ?? {};
        const current = await read(owner, botId);
        const entries = Object.entries(input);
        if (!entries.length || entries.some(([key, value]) => typeof value !== 'boolean' || !current.some(item => item.id === key))) {
          throwIpcError('INVALID_PARAMS', 'Invalid automation input');
        }
        for (const [key, value] of entries) {
          const item = current.find(candidate => candidate.id === key)!;
          if (item.status === 'expired' || (item.status === 'active') === value) continue;
          await (value ? deps.automations.resume(key) : deps.automations.pause(key));
          deps.assertOwner(owner);
        }
        return { effects: [{ kind: 'refresh-resource', ref: ref(id) }] };
      });
    }
    const schedule = items.find(item => item.id === scheduleId);
    if (!schedule) throwIpcError('NOT_FOUND', 'Automation unavailable');
    const { frequency, when } = automationTiming(schedule!, locale);
    const active = schedule!.status === 'active';
    // Same as the Automations page: pausing stops runs in progress, so it asks first.
    const inflight = active ? await deps.automations.inflight(scheduleId) : 0; deps.assertOwner(owner);
    const label = name('bots.automations.toggle', { name: schedule!.name });
    const resource: RemoteResource = {
      ref: ref(`${id}/${scheduleId}`), revision: hash(state(schedule!)), display: { title: schedule!.name }, links: [],
      blocks: [{ id: 'automation', primitive: 'form', title: copy['bots.automations.title'], fallbackMarkdown: [frequency, when].filter(Boolean).join('\n\n'),
        data: { actionId: 'automation', values: { active } } }],
      actions: [{ id: 'automation', label: copy['bots.automations.title'], fields: [{ id: 'active', label, kind: 'toggle' }],
        disabled: schedule!.status === 'expired',
        ...(inflight > 0 ? { confirmation: {
          title: name('scheduler.confirm.pause.title', { name: schedule!.name }),
          body: name('scheduler.confirm.pause.withInflight', { count: inflight }),
          confirmLabel: copy['scheduler.confirm.pause.confirm'],
        } } : {}) }],
    };
    return bind(context, resource, async () => {
      const current = (await read(owner, botId)).find(item => item.id === scheduleId);
      if (!current) throwIpcError('NOT_FOUND', 'Automation unavailable');
      return hash(state(current!));
    }, async invoke => {
      const input = invoke.input ?? {};
      if (Object.keys(input).some(key => key !== 'active') || typeof input.active !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid automation input');
      if (input.active !== active) {
        await (input.active ? deps.automations.resume(scheduleId) : deps.automations.pause(scheduleId));
        deps.assertOwner(owner);
      }
      const receipt: RemoteActionInvokeResponse = { effects: [
        { kind: 'refresh-resource', ref: ref(`${id}/${scheduleId}`) }, { kind: 'refresh-resource', ref: ref(id) },
      ] };
      return receipt;
    });
  };
}
