/**
 * ghostForm.ts — 表单弹窗槽(form,2026-11-23)的载荷形状、上限与校验。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'form-request', title, fields, values?, ...}`,请主机弹一个
 * **主机画的**表单弹窗(和 Cindy 自己的表单同一套组件、遮罩与按钮),用户点「保存」后
 * 把填好的值交回插件。确认弹窗(confirm 槽)只能问一句「是/否」;插件要用户填一组
 * 设置时,以前只能在自己的页面里画一个假弹窗——设置区的页面盖不住 Cindy 窗口,
 * 遮罩也只压暗自己那一块。本槽把表单交给主机画。
 *
 * 这里只放 main 与 renderer 共用的纯逻辑:
 * - parseGhostFormRequest:main 校验插件的请求,产出规整后的表单(字符串已净化、
 *   截长、字段去重,初始值按字段收口);
 * - coerceGhostFormValues:把任意值按表单字段收口——用于插件给的初始值,也用于
 *   renderer 回传的结果(main 不信 renderer 回包的形状,按原表单再收一遍);
 * - ghostFormMissingRequired:renderer 保存前找没填的必填项。
 *
 * 值只有字符串、布尔与列表三种;列表的每一项是 `{ id?, <字段 key>: 值 }`。
 * `id` 是插件给已有条目的不透明标识,主机原样带回(新加的条目没有 id),
 * 插件据此把改动对回自己的记录。
 */

export const GHOST_FORM_TITLE_MAX_CHARS = 40;
export const GHOST_FORM_DESCRIPTION_MAX_CHARS = 300;
export const GHOST_FORM_LABEL_MAX_CHARS = 40;
export const GHOST_FORM_HINT_MAX_CHARS = 120;
export const GHOST_FORM_PLACEHOLDER_MAX_CHARS = 80;
/** 按钮文案上限(与确认弹窗同宽)。 */
export const GHOST_FORM_BUTTON_MAX_CHARS = 12;
/** 危险操作的二次确认问句上限(与确认弹窗正文同上限)。 */
export const GHOST_FORM_ACTION_CONFIRM_MAX_CHARS = 300;
/** 顶层字段数上限(列表算一个)。 */
export const GHOST_FORM_MAX_FIELDS = 12;
/** 列表每一项里的字段数上限。 */
export const GHOST_FORM_MAX_ITEM_FIELDS = 8;
export const GHOST_FORM_MAX_OPTIONS = 50;
/** 选项值上限:项目目录这类值可能是一整条路径。 */
export const GHOST_FORM_OPTION_VALUE_MAX_CHARS = 512;
export const GHOST_FORM_OPTION_LABEL_MAX_CHARS = 60;
/** 文本字段 maxLength 的上限与缺省值。 */
export const GHOST_FORM_TEXT_MAX_CHARS = 2000;
export const GHOST_FORM_TEXT_DEFAULT_MAX_CHARS = 200;
export const GHOST_FORM_LIST_MAX_ITEMS = 20;
/**
 * 同一插件两次表单请求的最小间隔 ms,从上一次请求或上一个表单关掉(以晚者为准)算起。
 * 比确认弹窗短:用户关掉一个表单紧接着点开下一个是常见操作;从关掉时算起,插件也没法在
 * 用户刚关掉时立刻再弹。
 */
export const GHOST_FORM_MIN_INTERVAL_MS = 1000;
/**
 * 无人应答的兜底超时 ms:到点按「取消」处理并收起弹窗。
 * 填表比点一下确认慢得多,所以比确认弹窗的 90 秒长;插件页等结果时要按这个量级设超时。
 */
export const GHOST_FORM_TIMEOUT_MS = 10 * 60 * 1000;

/** 字段 key:字母开头,字母数字下划线。`id` 留给列表条目的标识。 */
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** 列表条目 id 与额外操作 id 的形状。 */
export const GHOST_FORM_ITEM_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ACTION_ID_RE = /^[A-Za-z0-9_.:-]{1,32}$/;
/** 额外操作可选的图标(主机图标集里的固定几个);有图标时画成方形图标按钮,文案作为悬停提示和读屏名字。 */
export const GHOST_FORM_ACTION_ICONS = ['trash'] as const;
export type GhostFormActionIcon = (typeof GHOST_FORM_ACTION_ICONS)[number];

export interface GhostFormOption {
  value: string;
  label: string;
}

interface FieldBase {
  key: string;
  label: string;
  hint: string | null;
}

export interface GhostFormTextField extends FieldBase {
  type: 'text' | 'textarea';
  placeholder: string | null;
  required: boolean;
  maxLength: number;
}

export interface GhostFormSelectField extends FieldBase {
  type: 'select';
  placeholder: string | null;
  required: boolean;
  options: GhostFormOption[];
}

/** 几个短选项的单选,画成分段控件;总有一个选中(缺省第一个)。 */
export interface GhostFormChoiceField extends FieldBase {
  type: 'choice';
  options: GhostFormOption[];
}

export interface GhostFormSwitchField extends FieldBase {
  type: 'switch';
}

export type GhostFormLeafField =
  | GhostFormTextField
  | GhostFormSelectField
  | GhostFormChoiceField
  | GhostFormSwitchField;

/** 可增删的一组条目(例如「要处理的事」),每项由若干基础字段组成。 */
export interface GhostFormListField extends FieldBase {
  type: 'list';
  /** 条目标题前缀,画成「<itemLabel> 1」「<itemLabel> 2」。 */
  itemLabel: string;
  /** 「添加」按钮文案;null = 主机缺省。 */
  addText: string | null;
  maxItems: number;
  fields: GhostFormLeafField[];
}

export type GhostFormField = GhostFormLeafField | GhostFormListField;

export type GhostFormLeafValue = string | boolean;
/** 列表的一项:字段 key → 值,外加可选的 `id`。 */
export type GhostFormListItem = Record<string, GhostFormLeafValue>;
export type GhostFormValues = Record<string, GhostFormLeafValue | GhostFormListItem[]>;

/** 表单底部除「取消」「保存」外的一个额外操作(例如「取消关注」)。 */
export interface GhostFormAction {
  id: string;
  text: string;
  danger: boolean;
  /** 非空时,点了先由主机再问一次(主机同款确认框),确认后才算点了这个操作。 */
  confirm: string | null;
  /** null = 文字按钮。 */
  icon: GhostFormActionIcon | null;
}

/** 规整后的表单(main → renderer 的载荷主体)。 */
export interface GhostFormSpec {
  title: string;
  description: string | null;
  fields: GhostFormField[];
  values: GhostFormValues;
  /** null = 主机缺省文案(跟用户语言走)。 */
  submitText: string | null;
  cancelText: string | null;
  action: GhostFormAction | null;
}

/**
 * form 的 invoke 返回。`ok:true` 只代表**问到了**,答案看 `outcome`:
 * submit = 用户点了保存(带 values);cancel = 取消 / Esc / 超时 / 窗口关了;
 * action = 用户点了额外操作(需要二次确认的,已确认)。
 */
export type GhostPipeFormResult =
  | { ok: true; outcome: 'submit'; values: GhostFormValues }
  | { ok: true; outcome: 'cancel' }
  | { ok: true; outcome: 'action'; action: string }
  | {
      ok: false;
      errorCode:
        | 'PERMISSION_DENIED'
        | 'INVALID_REQUEST'
        | 'RATE_LIMITED'
        | 'BUSY'
        | 'UNAVAILABLE'
        | 'INTERNAL';
      message: string;
    };

/** renderer 回给 main 的答复(main 再按原表单收口)。 */
export type GhostFormAnswer =
  | { outcome: 'submit'; values: unknown }
  | { outcome: 'cancel' }
  | { outcome: 'action' };

type Sanitize = (raw: string) => string;
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 必填文案:非空、净化后不超限。超长直接拒——静默截断会让作者以为自己写的话完整显示了。 */
function requiredText(raw: unknown, max: number, name: string, sanitize: Sanitize): Parsed<string> {
  if (typeof raw !== 'string') return { ok: false, message: `${name} 必须是字符串` };
  const text = sanitize(raw);
  if (!text) return { ok: false, message: `${name} 不能为空` };
  if (text.length > max) return { ok: false, message: `${name} 过长(上限 ${max} 字符)` };
  return { ok: true, value: text };
}

/** 可选文案:缺省或空白 → null。 */
function optionalText(raw: unknown, max: number, name: string, sanitize: Sanitize): Parsed<string | null> {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, message: `${name} 必须是字符串` };
  const text = sanitize(raw);
  if (!text) return { ok: true, value: null };
  if (text.length > max) return { ok: false, message: `${name} 过长(上限 ${max} 字符)` };
  return { ok: true, value: text };
}

function parseOptions(raw: unknown, name: string, sanitize: Sanitize): Parsed<GhostFormOption[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: `${name}.options 必须是非空数组` };
  if (raw.length > GHOST_FORM_MAX_OPTIONS) return { ok: false, message: `${name}.options 最多 ${GHOST_FORM_MAX_OPTIONS} 项` };
  const options: GhostFormOption[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.value !== 'string') return { ok: false, message: `${name}.options 的每项须有字符串 value` };
    if (!item.value || item.value.length > GHOST_FORM_OPTION_VALUE_MAX_CHARS) {
      return { ok: false, message: `${name}.options 的 value 不能为空且不超过 ${GHOST_FORM_OPTION_VALUE_MAX_CHARS} 字符` };
    }
    if (options.some((o) => o.value === item.value)) return { ok: false, message: `${name}.options 的 value 重复` };
    const label = requiredText(item.label, GHOST_FORM_OPTION_LABEL_MAX_CHARS, `${name}.options.label`, sanitize);
    if (!label.ok) return label;
    options.push({ value: item.value, label: label.value });
  }
  return { ok: true, value: options };
}

function parseLeaf(raw: Record<string, unknown>, name: string, sanitize: Sanitize): Parsed<GhostFormLeafField> {
  const key = raw.key as string;
  const label = requiredText(raw.label, GHOST_FORM_LABEL_MAX_CHARS, `${name}.label`, sanitize);
  if (!label.ok) return label;
  const hint = optionalText(raw.hint, GHOST_FORM_HINT_MAX_CHARS, `${name}.hint`, sanitize);
  if (!hint.ok) return hint;
  const base = { key, label: label.value, hint: hint.value };
  if (raw.required !== undefined && typeof raw.required !== 'boolean') return { ok: false, message: `${name}.required 必须是布尔值` };
  switch (raw.type) {
    case 'text':
    case 'textarea': {
      const placeholder = optionalText(raw.placeholder, GHOST_FORM_PLACEHOLDER_MAX_CHARS, `${name}.placeholder`, sanitize);
      if (!placeholder.ok) return placeholder;
      let maxLength = GHOST_FORM_TEXT_DEFAULT_MAX_CHARS;
      if (raw.maxLength !== undefined) {
        if (!Number.isInteger(raw.maxLength) || (raw.maxLength as number) < 1 || (raw.maxLength as number) > GHOST_FORM_TEXT_MAX_CHARS) {
          return { ok: false, message: `${name}.maxLength 须是 1–${GHOST_FORM_TEXT_MAX_CHARS} 的整数` };
        }
        maxLength = raw.maxLength as number;
      }
      return { ok: true, value: { ...base, type: raw.type, placeholder: placeholder.value, required: raw.required === true, maxLength } };
    }
    case 'select': {
      const placeholder = optionalText(raw.placeholder, GHOST_FORM_PLACEHOLDER_MAX_CHARS, `${name}.placeholder`, sanitize);
      if (!placeholder.ok) return placeholder;
      const options = parseOptions(raw.options, name, sanitize);
      if (!options.ok) return options;
      return { ok: true, value: { ...base, type: 'select', placeholder: placeholder.value, required: raw.required === true, options: options.value } };
    }
    case 'choice': {
      const options = parseOptions(raw.options, name, sanitize);
      if (!options.ok) return options;
      // 分段控件放不下太多选项,也放不下长文案。
      if (options.value.length > 5) return { ok: false, message: `${name}.options 最多 5 项(更多用 select)` };
      if (options.value.some((o) => o.label.length > 12)) return { ok: false, message: `${name}.options 的 label 不超过 12 字符(更长用 select)` };
      return { ok: true, value: { ...base, type: 'choice', options: options.value } };
    }
    case 'switch':
      return { ok: true, value: { ...base, type: 'switch' } };
    default:
      return { ok: false, message: `${name}.type 不支持(text / textarea / select / choice / switch / list)` };
  }
}

function parseFields(raw: unknown, max: number, name: string, sanitize: Sanitize, allowList: boolean): Parsed<GhostFormField[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: `${name} 必须是非空数组` };
  if (raw.length > max) return { ok: false, message: `${name} 最多 ${max} 个字段` };
  const fields: GhostFormField[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const at = `${name}[${i}]`;
    if (!isRecord(item)) return { ok: false, message: `${at} 必须是对象` };
    if (typeof item.key !== 'string' || !FIELD_KEY_RE.test(item.key) || item.key === 'id') {
      return { ok: false, message: `${at}.key 须以字母开头、只含字母数字下划线(≤32),且不能是 id` };
    }
    if (fields.some((f) => f.key === item.key)) return { ok: false, message: `${at}.key 重复` };
    if (item.type === 'list') {
      if (!allowList) return { ok: false, message: `${at}: 列表里不能再套列表` };
      const label = requiredText(item.label, GHOST_FORM_LABEL_MAX_CHARS, `${at}.label`, sanitize);
      if (!label.ok) return label;
      const hint = optionalText(item.hint, GHOST_FORM_HINT_MAX_CHARS, `${at}.hint`, sanitize);
      if (!hint.ok) return hint;
      const itemLabel = requiredText(item.itemLabel, GHOST_FORM_LABEL_MAX_CHARS, `${at}.itemLabel`, sanitize);
      if (!itemLabel.ok) return itemLabel;
      const addText = optionalText(item.addText, GHOST_FORM_LABEL_MAX_CHARS, `${at}.addText`, sanitize);
      if (!addText.ok) return addText;
      if (!Number.isInteger(item.maxItems) || (item.maxItems as number) < 1 || (item.maxItems as number) > GHOST_FORM_LIST_MAX_ITEMS) {
        return { ok: false, message: `${at}.maxItems 须是 1–${GHOST_FORM_LIST_MAX_ITEMS} 的整数` };
      }
      const inner = parseFields(item.fields, GHOST_FORM_MAX_ITEM_FIELDS, `${at}.fields`, sanitize, false);
      if (!inner.ok) return inner;
      fields.push({
        type: 'list', key: item.key, label: label.value, hint: hint.value, itemLabel: itemLabel.value,
        addText: addText.value, maxItems: item.maxItems as number, fields: inner.value as GhostFormLeafField[],
      });
      continue;
    }
    const leaf = parseLeaf(item, at, sanitize);
    if (!leaf.ok) return leaf;
    fields.push(leaf.value);
  }
  return { ok: true, value: fields };
}

/** 去掉控制字符;单行文本把换行压成空格。用户填的值不 trim(保存的就是用户看到的)。 */
function cleanInput(raw: string, multiline: boolean, max: number): string {
  // eslint-disable-next-line no-control-regex
  let text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
  if (!multiline) text = text.replace(/\n/g, ' ');
  return text.length > max ? text.slice(0, max) : text;
}

function coerceLeaf(field: GhostFormLeafField, raw: unknown): GhostFormLeafValue {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return typeof raw === 'string' ? cleanInput(raw, field.type === 'textarea', field.maxLength) : '';
    case 'select':
      return typeof raw === 'string' && field.options.some((o) => o.value === raw) ? raw : '';
    case 'choice':
      return typeof raw === 'string' && field.options.some((o) => o.value === raw) ? raw : field.options[0].value;
    case 'switch':
      return raw === true;
  }
}

function coerceItem(fields: GhostFormLeafField[], raw: unknown): GhostFormListItem {
  const source = isRecord(raw) ? raw : {};
  const item: GhostFormListItem = {};
  if (typeof source.id === 'string' && GHOST_FORM_ITEM_ID_RE.test(source.id)) item.id = source.id;
  for (const field of fields) item[field.key] = coerceLeaf(field, source[field.key]);
  return item;
}

/**
 * 把任意值按表单字段收口:每个字段都有值、类型对、选项值在选项里、文本不超长、
 * 列表不超过上限;表单里没有的 key 丢掉。`select` 的值不在选项里时清空(由用户重选),
 * `choice` 落回第一个选项。列表条目的 id 只保留合法形状的。
 */
export function coerceGhostFormValues(fields: GhostFormField[], raw: unknown): GhostFormValues {
  const source = isRecord(raw) ? raw : {};
  const values: GhostFormValues = {};
  for (const field of fields) {
    if (field.type === 'list') {
      const items = Array.isArray(source[field.key]) ? (source[field.key] as unknown[]) : [];
      values[field.key] = items.slice(0, field.maxItems).map((item) => coerceItem(field.fields, item));
    } else {
      values[field.key] = coerceLeaf(field, source[field.key]);
    }
  }
  return values;
}

/** 校验并规整插件的表单请求。sanitize 由 main 注入(与确认弹窗同一个净化函数)。 */
export function parseGhostFormRequest(raw: unknown, sanitize: Sanitize): Parsed<GhostFormSpec> {
  if (!isRecord(raw)) return { ok: false, message: 'form-request 载荷必须是对象' };
  const title = requiredText(raw.title, GHOST_FORM_TITLE_MAX_CHARS, 'title', sanitize);
  if (!title.ok) return title;
  const description = optionalText(raw.description, GHOST_FORM_DESCRIPTION_MAX_CHARS, 'description', sanitize);
  if (!description.ok) return description;
  const fields = parseFields(raw.fields, GHOST_FORM_MAX_FIELDS, 'fields', sanitize, true);
  if (!fields.ok) return fields;
  const submitText = optionalText(raw.submitText, GHOST_FORM_BUTTON_MAX_CHARS, 'submitText', sanitize);
  if (!submitText.ok) return submitText;
  const cancelText = optionalText(raw.cancelText, GHOST_FORM_BUTTON_MAX_CHARS, 'cancelText', sanitize);
  if (!cancelText.ok) return cancelText;
  if (raw.values !== undefined && !isRecord(raw.values)) return { ok: false, message: 'values 必须是对象' };
  let action: GhostFormAction | null = null;
  if (raw.action !== undefined) {
    if (!isRecord(raw.action)) return { ok: false, message: 'action 必须是对象' };
    if (typeof raw.action.id !== 'string' || !ACTION_ID_RE.test(raw.action.id)) {
      return { ok: false, message: 'action.id 须是 1–32 位字母数字或 _.:-' };
    }
    const text = requiredText(raw.action.text, GHOST_FORM_BUTTON_MAX_CHARS, 'action.text', sanitize);
    if (!text.ok) return text;
    if (raw.action.danger !== undefined && typeof raw.action.danger !== 'boolean') return { ok: false, message: 'action.danger 必须是布尔值' };
    const confirm = optionalText(raw.action.confirm, GHOST_FORM_ACTION_CONFIRM_MAX_CHARS, 'action.confirm', sanitize);
    if (!confirm.ok) return confirm;
    const icon = raw.action.icon;
    if (icon !== undefined && !(GHOST_FORM_ACTION_ICONS as readonly unknown[]).includes(icon)) {
      return { ok: false, message: `action.icon 只支持 ${GHOST_FORM_ACTION_ICONS.join(' / ')}` };
    }
    action = {
      id: raw.action.id, text: text.value, danger: raw.action.danger === true, confirm: confirm.value,
      icon: (icon as GhostFormActionIcon | undefined) ?? null,
    };
  }
  return {
    ok: true,
    value: {
      title: title.value,
      description: description.value,
      fields: fields.value,
      values: coerceGhostFormValues(fields.value, raw.values),
      submitText: submitText.value,
      cancelText: cancelText.value,
      action,
    },
  };
}

/** 没填的必填项:顶层返回字段 key,列表条目返回 `<列表 key>.<条目序号>.<字段 key>`。 */
export function ghostFormMissingRequired(fields: GhostFormField[], values: GhostFormValues): string[] {
  const missing: string[] = [];
  const empty = (field: GhostFormLeafField, value: unknown) =>
    (field.type === 'text' || field.type === 'textarea' || field.type === 'select') && field.required &&
    (typeof value !== 'string' || !value.trim());
  for (const field of fields) {
    if (field.type === 'list') {
      const items = Array.isArray(values[field.key]) ? (values[field.key] as GhostFormListItem[]) : [];
      items.forEach((item, index) => {
        for (const inner of field.fields) if (empty(inner, item[inner.key])) missing.push(`${field.key}.${index}.${inner.key}`);
      });
    } else if (empty(field, values[field.key])) {
      missing.push(field.key);
    }
  }
  return missing;
}
