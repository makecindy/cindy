import { z } from 'zod';

export type BrowserToolCategory = 'browser';

export type BrowserToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface BrowserToolResult {
  content: BrowserToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type BrowserToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<BrowserToolResult>;

export interface BrowserToolDef {
  name: string;
  category: BrowserToolCategory;
  description: string;
  /**
   * Keys of shared rule documents that apply to this tool. The registry stores
   * only keys; the actual markdown lives in a parallel rules registry and is
   * bundled into `list_tools` responses ONCE per category instead of being
   * duplicated in every tool description.
   */
  rules?: string[];
  inputShape: z.ZodRawShape;
  /**
   * Moves arguments the agent put in an unambiguous wrong place before strict validation (for example
   * extraction fields written next to `extract` instead of inside it). Anything else still fails.
   */
  normalizeArgs?: (raw: Record<string, unknown>) => Record<string, unknown>;
  handler: BrowserToolHandler;
}

export interface BrowserToolSummary {
  name: string;
  category: BrowserToolCategory;
  description: string;
  rules?: string[];
}

export class BrowserToolRegistry {
  private readonly tools = new Map<string, BrowserToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: BrowserToolCategory;
    description: string;
    rules?: string[];
    inputShape: T;
    normalizeArgs?: (raw: Record<string, unknown>) => Record<string, unknown>;
    handler: BrowserToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[browserToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as BrowserToolDef);
  }

  list(category?: BrowserToolCategory): BrowserToolSummary[] {
    const all: BrowserToolSummary[] = [];
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      all.push({
        name: t.name,
        category: t.category,
        description: t.description,
        ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
      });
    }
    return all;
  }

  /**
   * Collect the union of rule keys referenced by tools in the given category
   * (or all tools if omitted). Used by `list_tools` to deduplicate shared rule
   * markdown into a single block per response.
   */
  collectRuleKeys(category?: BrowserToolCategory): string[] {
    const set = new Set<string>();
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      for (const k of t.rules ?? []) set.add(k);
    }
    return Array.from(set);
  }

  listCategories(): BrowserToolCategory[] {
    const set = new Set<BrowserToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<BrowserToolResult> {
    const def = this.tools.get(name);
    if (!def) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              errorCode: 'UNKNOWN_TOOL',
              data: {
                requested: name,
                available: Array.from(this.tools.keys()),
                hint: '调用 list_tools 查看完整工具列表',
              },
            }),
          },
        ],
        isError: true,
      };
    }

    // strict:未知字段直接判失败(而非默默剥掉)。否则 agent 传了拼错 / 不支持的字段会
    // "返回成功、实际忽略",误导其以为生效(典型:camelCase 写成 sessionIds 而非 session_ids)。
    // 失败分支已带 schema + hint,agent 可据此自纠重试。
    const objSchema = z.strictObject(def.inputShape);
    const input = rawArgs && typeof rawArgs === 'object' && def.normalizeArgs ? def.normalizeArgs(rawArgs as Record<string, unknown>) : rawArgs;
    const parsed = objSchema.safeParse(input ?? {});
    if (!parsed.success) {
      let jsonSchema: unknown;
      try {
        jsonSchema = z.toJSONSchema(objSchema);
      } catch {
        jsonSchema = '<schema serialization failed>';
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              errorCode: 'INVALID_ARGS',
              data: {
                tool: name,
                validation_errors: parsed.error.issues,
                schema: jsonSchema,
                hint: '请按 schema 修正参数后重试',
              },
            }),
          },
        ],
        isError: true,
      };
    }

    return def.handler(parsed.data as Record<string, unknown>);
  }
}
