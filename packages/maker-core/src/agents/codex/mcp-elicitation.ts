import { askAnswerError } from '@cindy/maker-shared/interaction';
import type { AskUserQuestionItem, InteractionDecision } from '../../types/events.js';

type Field = { id: string; required: boolean; type: 'string' | 'boolean'; values?: string[] };
type Form = { questions: AskUserQuestionItem[]; fields: Field[] };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The ordinary, non-secret MCP form subset supported by Codex's native editor. */
export function parseMcpElicitationForm(schema: unknown, message: string): Form | undefined {
  const root = record(schema);
  const properties = record(root?.properties);
  if (root?.type !== 'object' || !properties || !Object.keys(properties).length) return undefined;
  if (Object.keys(root).some((key) => !['type', 'properties', 'required', 'title', 'description', '$schema', 'additionalProperties'].includes(key))) return undefined;
  const fields: Field[] = [];
  const questions: AskUserQuestionItem[] = [];
  for (const [id, raw] of Object.entries(properties)) {
    const property = record(raw);
    if (!property || property.writeOnly === true || property.format === 'password' || property.isSecret === true) return undefined;
    if (property.type !== 'string' && property.type !== 'boolean') return undefined;
    // Do not silently accept validation keywords the editor cannot enforce.
    const supported = ['type', 'title', 'description', 'default', 'enum', 'enumNames', 'oneOf', 'minLength', 'maxLength', 'writeOnly', 'isSecret'];
    if (Object.keys(property).some((key) => !supported.includes(key))) return undefined;
    if (property.type === 'boolean' && ['enum', 'oneOf', 'minLength', 'maxLength'].some((key) => key in property)) return undefined;
    for (const key of ['minLength', 'maxLength']) {
      if (key in property && (!Number.isSafeInteger(property[key]) || Number(property[key]) < 0)) return undefined;
    }
    if (typeof property.minLength === 'number' && typeof property.maxLength === 'number' && property.minLength > property.maxLength) return undefined;
    if ('enum' in property && 'oneOf' in property) return undefined;
    if ('enum' in property && !Array.isArray(property.enum)) return undefined;
    if ('oneOf' in property && !Array.isArray(property.oneOf)) return undefined;
    let values: string[] | undefined;
    let descriptions: string[] = [];
    if (property.type === 'boolean') values = ['true', 'false'];
    else if (Array.isArray(property.enum)) {
      if (!property.enum.length || !property.enum.every((v): v is string => typeof v === 'string' && v.length > 0)) return undefined;
      values = property.enum;
      descriptions = Array.isArray(property.enumNames) ? property.enumNames.map((v) => typeof v === 'string' ? v : '') : [];
    } else if (Array.isArray(property.oneOf)) {
      const choices = property.oneOf.map(record);
      if (!choices.length || choices.some((v) => typeof v?.const !== 'string' || !v.const || Object.keys(v).some((key) => !['const', 'title', 'description', 'type'].includes(key)) || (v.type !== undefined && v.type !== 'string'))) return undefined;
      values = choices.map((v) => v!.const as string);
      descriptions = choices.map((v) => typeof v!.title === 'string' ? v!.title : '');
    }
    fields.push({ id, type: property.type, required: Array.isArray(root.required) && root.required.includes(id), values });
    const title = typeof property.title === 'string' ? property.title : id;
    const description = typeof property.description === 'string' ? property.description : '';
    questions.push({ id, header: title, question: [message, title, description].filter(Boolean).join('\n\n'),
      ...(values ? { options: values.map((label, i) => ({ label, description: descriptions[i] })) } : {}), multiSelect: false,
      answerConstraints: { required: fields[fields.length - 1].required,
        ...(values ? { choices: values } : {}),
        ...(typeof property.minLength === 'number' ? { minLength: property.minLength } : {}),
        ...(typeof property.maxLength === 'number' ? { maxLength: property.maxLength } : {}),
      } });
  }
  return { fields, questions };
}

export function mcpElicitationFormContent(form: Form, decision: InteractionDecision): Record<string, string | boolean> | undefined {
  if (decision.kind !== 'ask_user_question' || decision.dismissed || !Object.keys(decision.answers).length) return undefined;
  const entries: Array<[string, string | boolean]> = [];
  for (const field of form.fields) {
    const question = form.questions.find((q) => q.id === field.id)!;
    const answer = decision.answers[field.id] ?? decision.answers[question.question];
    if (askAnswerError(question, answer ?? '')) return undefined;
    if (!answer?.trim()) {
      if (field.required) return undefined;
      continue;
    }
    if (field.values && !field.values.includes(answer)) return undefined;
    entries.push([field.id, field.type === 'boolean' ? answer === 'true' : answer]);
  }
  return Object.fromEntries(entries);
}

export function mcpElicitationUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
