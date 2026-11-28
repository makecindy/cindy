/**
 * ACP Form Elicitation (`elicitation/create`) ↔ Cindy `ask_user_question`.
 *
 * Translates an ACP agent's JSON Schema form into Cindy's native question card
 * (`AskUserQuestionItem[]`) and encodes the user's answer back into an ACP
 * `ElicitationResult` (`accept` / `decline` / `cancel`).
 *
 * When a choice field `k` is accompanied by an optional plain-string write-in
 * field `${k}_other` (as Antigravity's `ask_question` bridge emits), the pair
 * is collapsed into a single Cindy question with choices plus Cindy's built-in
 * custom-answer box, instead of splitting one question into two wizard steps.
 */

import type { AskUserQuestionItem, InteractionDecision } from '../../types/events.js';
import {
  asNonEmptyString,
  asRecord,
  type AcpElicitationResult,
  type AcpElicitationValue,
  type AcpRecord,
} from './protocol.js';

export interface AcpElicitationChoice {
  /** Wire value returned in `content[field.id]` (schema `const` or `enum` value). */
  value: string;
  /** Human-readable option label shown in Cindy's question card. */
  label: string;
  description?: string;
}

export type AcpElicitationField =
  | {
      kind: 'single';
      id: string;
      questionText: string;
      required: boolean;
      options: AcpElicitationChoice[];
      /** Companion optional free-form string key (e.g. `q1_other`) folded into this question. */
      writeInKey?: string;
    }
  | {
      kind: 'multi';
      id: string;
      questionText: string;
      required: boolean;
      options: AcpElicitationChoice[];
      minItems?: number;
      maxItems?: number;
      writeInKey?: string;
    }
  | {
      kind: 'boolean';
      id: string;
      questionText: string;
      required: boolean;
    }
  | {
      kind: 'string';
      id: string;
      questionText: string;
      required: boolean;
      minLength?: number;
      maxLength?: number;
    }
  | {
      kind: 'number' | 'integer';
      id: string;
      questionText: string;
      required: boolean;
      minimum?: number;
      maximum?: number;
    };

export interface AcpElicitationForm {
  questions: AskUserQuestionItem[];
  fields: AcpElicitationField[];
}

const GENERIC_QUESTION_COUNT_MESSAGE = /^the agent has \d+ questions?\.?$/i;

function isSecretProperty(property: AcpRecord): boolean {
  return property.writeOnly === true || property.format === 'password' || property.isSecret === true;
}

function isPlainOptionalWriteIn(property: AcpRecord, required: ReadonlySet<string>, key: string): boolean {
  if (required.has(key) || isSecretProperty(property)) return false;
  if (property.type !== 'string') return false;
  if ('enum' in property || 'oneOf' in property || 'anyOf' in property) return false;
  return true;
}

function normalizeChoiceList(entries: readonly unknown[]): AcpElicitationChoice[] | null {
  if (entries.length === 0) return null;
  const raw: AcpElicitationChoice[] = [];
  for (const entry of entries) {
    const rec = asRecord(entry);
    const value = asNonEmptyString(rec.const);
    if (!value) return null;
    if (rec.type !== undefined && rec.type !== 'string') return null;
    const title = asNonEmptyString(rec.title);
    const description = asNonEmptyString(rec.description);
    raw.push({
      value,
      label: title ?? value,
      ...(description && description !== (title ?? value) ? { description } : {}),
    });
  }
  return deduplicateLabels(raw);
}

function normalizeEnumChoices(rawEnum: readonly unknown[], rawNames?: unknown): AcpElicitationChoice[] | null {
  if (rawEnum.length === 0) return null;
  const names = Array.isArray(rawNames) ? rawNames : [];
  const raw: AcpElicitationChoice[] = [];
  for (let i = 0; i < rawEnum.length; i += 1) {
    const value = asNonEmptyString(rawEnum[i]);
    if (!value) return null;
    const name = asNonEmptyString(names[i]);
    raw.push({
      value,
      label: name ?? value,
    });
  }
  return deduplicateLabels(raw);
}

/** Ensures option labels within a question are unique so label → wire value stays unambiguous. */
function deduplicateLabels(choices: AcpElicitationChoice[]): AcpElicitationChoice[] {
  const counts = new Map<string, number>();
  for (const choice of choices) counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
  return choices.map((choice) => (
    (counts.get(choice.label) ?? 0) > 1 && choice.label !== choice.value
      ? { ...choice, label: `${choice.label} (${choice.value})` }
      : choice
  ));
}

function extractChoices(property: AcpRecord): AcpElicitationChoice[] | null {
  if (Array.isArray(property.oneOf)) return normalizeChoiceList(property.oneOf);
  if (Array.isArray(property.anyOf)) return normalizeChoiceList(property.anyOf);
  if (Array.isArray(property.enum)) return normalizeEnumChoices(property.enum, property.enumNames);
  return null;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatQuestionText(
  id: string,
  title: string | undefined,
  description: string | undefined,
  message: string | undefined,
  singleField: boolean,
): { header?: string; question: string } {
  const cleanMessage = message && !GENERIC_QUESTION_COUNT_MESSAGE.test(message) ? message : undefined;
  if (title) {
    const parts: string[] = [];
    if (singleField && cleanMessage && cleanMessage !== title) parts.push(cleanMessage);
    parts.push(title);
    if (description && description !== title && description !== cleanMessage) parts.push(description);
    return {
      ...(singleField && cleanMessage && cleanMessage !== title ? { header: title } : {}),
      question: parts.join('\n\n'),
    };
  }
  const parts: string[] = [];
  if (singleField && cleanMessage) parts.push(cleanMessage);
  if (description && description !== cleanMessage) parts.push(description);
  return {
    header: id,
    question: parts.length > 0 ? parts.join('\n\n') : id,
  };
}

/**
 * Parses an ACP `elicitation/create` params object into Cindy's question-card form.
 * Returns `null` when the request is not a supported form elicitation (e.g. `mode: 'url'`,
 * secret/password fields, or unsupported nested schemas), allowing the caller to reject cleanly
 * so the agent can fall back.
 */
export function parseAcpElicitationForm(params: AcpRecord): AcpElicitationForm | null {
  const mode = asNonEmptyString(params.mode);
  if (mode !== undefined && mode !== 'form') return null;

  const schema = asRecord(params.requestedSchema ?? params.requested_schema);
  const properties = asRecord(schema.properties);
  const keys = Object.keys(properties);
  if (schema.type !== 'object' || keys.length === 0) return null;

  const required = new Set<string>(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  const message = asNonEmptyString(params.message)?.trim();

  // First pass: detect companion `*_other` write-in fields paired with optional choice fields.
  // Never fold a required choice field with an optional `*_other`: custom-only text would omit
  // the required choice key and violate the schema.
  const writeInOwners = new Map<string, string>(); // selectKey -> writeInKey
  const absorbedWriteIns = new Set<string>();
  for (const key of keys) {
    if (required.has(key)) continue;
    const prop = asRecord(properties[key]);
    const isChoiceCandidate =
      (prop.type === 'string' && ('oneOf' in prop || 'anyOf' in prop || 'enum' in prop))
      || prop.type === 'array';
    if (!isChoiceCandidate) continue;
    const otherKey = `${key}_other`;
    if (Object.prototype.hasOwnProperty.call(properties, otherKey)) {
      const otherProp = asRecord(properties[otherKey]);
      if (isPlainOptionalWriteIn(otherProp, required, otherKey)) {
        writeInOwners.set(key, otherKey);
        absorbedWriteIns.add(otherKey);
      }
    }
  }

  const visibleKeys = keys.filter((key) => !absorbedWriteIns.has(key));
  if (visibleKeys.length === 0) return null;
  const singleField = visibleKeys.length === 1;

  const fields: AcpElicitationField[] = [];
  const questions: AskUserQuestionItem[] = [];

  for (const id of visibleKeys) {
    const prop = asRecord(properties[id]);
    if (Object.keys(prop).length === 0 || isSecretProperty(prop)) return null;
    const isRequired = required.has(id);
    const title = asNonEmptyString(prop.title)?.trim();
    const description = asNonEmptyString(prop.description)?.trim();
    const { header, question } = formatQuestionText(id, title, description, message, singleField);
    const writeInKey = writeInOwners.get(id);

    if (prop.type === 'boolean') {
      fields.push({ kind: 'boolean', id, questionText: question, required: isRequired });
      questions.push({
        id,
        ...(header ? { header } : {}),
        question,
        options: [{ label: 'true' }, { label: 'false' }],
        multiSelect: false,
        answerConstraints: { required: isRequired, choices: ['true', 'false'] },
      });
      continue;
    }

    if (prop.type === 'array') {
      const items = asRecord(prop.items);
      const choices = extractChoices(items);
      if (!choices) return null;
      const minItems = prop.minItems !== undefined ? nonNegativeInt(prop.minItems) : undefined;
      const maxItems = prop.maxItems !== undefined ? nonNegativeInt(prop.maxItems) : undefined;
      if ((prop.minItems !== undefined && minItems === undefined) || (prop.maxItems !== undefined && maxItems === undefined)) {
        return null;
      }
      if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) return null;
      if (minItems !== undefined && minItems > choices.length) return null;
      fields.push({
        kind: 'multi',
        id,
        questionText: question,
        required: isRequired,
        options: choices,
        ...(minItems !== undefined ? { minItems } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(writeInKey ? { writeInKey } : {}),
      });
      // Do not attach `answerConstraints.choices` on multiSelect: Cindy validates
      // `choices.includes(answer)` against the JSON-encoded array string.
      questions.push({
        id,
        ...(header ? { header } : {}),
        question,
        options: choices.map((choice) => ({
          label: choice.label,
          ...(choice.description ? { description: choice.description } : {}),
        })),
        multiSelect: true,
        ...(isRequired ? { answerConstraints: { required: true } } : {}),
      });
      continue;
    }

    if (prop.type === 'string') {
      const hasChoiceKeywords = 'oneOf' in prop || 'anyOf' in prop || 'enum' in prop;
      if (hasChoiceKeywords) {
        const choices = extractChoices(prop);
        if (!choices) return null;
        fields.push({
          kind: 'single',
          id,
          questionText: question,
          required: isRequired,
          options: choices,
          ...(writeInKey ? { writeInKey } : {}),
        });
        questions.push({
          id,
          ...(header ? { header } : {}),
          question,
          options: choices.map((choice) => ({
            label: choice.label,
            ...(choice.description ? { description: choice.description } : {}),
          })),
          multiSelect: false,
          // Keep Cindy's custom-answer box open when a companion write-in key exists.
          ...(writeInKey
            ? (isRequired ? { answerConstraints: { required: true } } : {})
            : { answerConstraints: { required: isRequired, choices: choices.map((c) => c.label) } }),
        });
        continue;
      }

      const minLength = nonNegativeInt(prop.minLength);
      const maxLength = nonNegativeInt(prop.maxLength);
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) return null;
      fields.push({
        kind: 'string',
        id,
        questionText: question,
        required: isRequired,
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {}),
      });
      questions.push({
        id,
        ...(header ? { header } : {}),
        question,
        multiSelect: false,
        answerConstraints: {
          required: isRequired,
          ...(minLength !== undefined ? { minLength } : {}),
          ...(maxLength !== undefined ? { maxLength } : {}),
        },
      });
      continue;
    }

    if (prop.type === 'number' || prop.type === 'integer') {
      const minimum = finiteNumber(prop.minimum);
      const maximum = finiteNumber(prop.maximum);
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) return null;
      fields.push({
        kind: prop.type,
        id,
        questionText: question,
        required: isRequired,
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
      });
      questions.push({
        id,
        ...(header ? { header } : {}),
        question,
        multiSelect: false,
        ...(isRequired ? { answerConstraints: { required: true } } : {}),
      });
      continue;
    }

    return null;
  }

  return { fields, questions };
}

function matchChoice(options: readonly AcpElicitationChoice[], answer: string): AcpElicitationChoice | undefined {
  return options.find((opt) => opt.label === answer) ?? options.find((opt) => opt.value === answer);
}

function parseMultiAnswerParts(answer: string): string[] {
  const trimmed = answer.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === 'string')) {
        return parsed.map((item) => item.trim()).filter(Boolean);
      }
    } catch {
      // Fall through and treat as a single free-form answer.
    }
  }
  return [trimmed];
}

/** Maps Cindy's `InteractionDecision` back to an ACP `ElicitationResult`. */
export function encodeAcpElicitationResponse(
  form: AcpElicitationForm,
  decision: InteractionDecision,
): AcpElicitationResult {
  if (decision.kind !== 'ask_user_question' || decision.dismissed === true) {
    return { action: 'cancel' };
  }
  if (Object.keys(decision.answers).length === 0) {
    return { action: 'decline' };
  }

  const content: Record<string, AcpElicitationValue> = {};
  for (const field of form.fields) {
    const raw = decision.answers[field.id] ?? decision.answers[field.questionText];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) {
      if (field.required) return { action: 'decline' };
      continue;
    }

    switch (field.kind) {
      case 'single': {
        const matched = matchChoice(field.options, trimmed);
        if (matched) {
          content[field.id] = matched.value;
        } else if (field.writeInKey && !field.required) {
          content[field.writeInKey] = trimmed;
        } else {
          return { action: 'decline' };
        }
        break;
      }
      case 'multi': {
        const parts = parseMultiAnswerParts(trimmed);
        const selected: string[] = [];
        const custom: string[] = [];
        for (const part of parts) {
          const matched = matchChoice(field.options, part);
          if (matched) {
            if (!selected.includes(matched.value)) selected.push(matched.value);
          } else {
            custom.push(part);
          }
        }
        if (custom.length > 0) {
          if (field.writeInKey) content[field.writeInKey] = custom.join('\n');
          else return { action: 'decline' };
        }
        if (selected.length > 0) {
          if (field.minItems !== undefined && selected.length < field.minItems) return { action: 'decline' };
          if (field.maxItems !== undefined && selected.length > field.maxItems) return { action: 'decline' };
          content[field.id] = selected;
        } else if (field.required) {
          return { action: 'decline' };
        }
        if (selected.length === 0 && custom.length === 0 && field.required) {
          return { action: 'decline' };
        }
        break;
      }
      case 'boolean': {
        const lower = trimmed.toLowerCase();
        if (lower === 'true' || lower === 'yes') content[field.id] = true;
        else if (lower === 'false' || lower === 'no') content[field.id] = false;
        else return { action: 'decline' };
        break;
      }
      case 'string': {
        const len = Array.from(trimmed).length;
        if (field.minLength !== undefined && len < field.minLength) return { action: 'decline' };
        if (field.maxLength !== undefined && len > field.maxLength) return { action: 'decline' };
        content[field.id] = trimmed;
        break;
      }
      case 'number':
      case 'integer': {
        const num = Number(trimmed);
        if (!Number.isFinite(num)) return { action: 'decline' };
        if (field.kind === 'integer' && !Number.isInteger(num)) return { action: 'decline' };
        if (field.minimum !== undefined && num < field.minimum) return { action: 'decline' };
        if (field.maximum !== undefined && num > field.maximum) return { action: 'decline' };
        content[field.id] = num;
        break;
      }
    }
  }

  if (Object.keys(content).length === 0) return { action: 'decline' };
  return { action: 'accept', content };
}
