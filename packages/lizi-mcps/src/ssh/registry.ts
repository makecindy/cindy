/**
 * ssh/registry.ts
 * ---------------------------------------------------------------------------
 * Mirrors SchedulerToolRegistry — fine-grained ssh tools register here, NOT
 * directly on the McpServer. The MCP server only exposes `list_tools` +
 * `call_tool` entry tools, keeping startup context cost low. INVALID_ARGS
 * surfaces the JSON schema so the model self-corrects.
 *
 * One category 'ssh' for now.
 */

import { z } from 'zod';

export type SshToolCategory = 'ssh';

export type SshToolContentBlock = { type: 'text'; text: string };

export interface SshToolResult {
  content: SshToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type SshToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<SshToolResult>;

export interface SshToolDef {
  name: string;
  category: SshToolCategory;
  description: string;
  inputShape: z.ZodRawShape;
  handler: SshToolHandler;
}

export interface SshToolSummary {
  name: string;
  category: SshToolCategory;
  description: string;
}

export class SshToolRegistry {
  private readonly tools = new Map<string, SshToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: SshToolCategory;
    description: string;
    inputShape: T;
    handler: SshToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[cindy_ssh registry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as SshToolDef);
  }

  list(category?: SshToolCategory): SshToolSummary[] {
    const all: SshToolSummary[] = [];
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      all.push({ name: t.name, category: t.category, description: t.description });
    }
    return all;
  }

  listCategories(): SshToolCategory[] {
    const set = new Set<SshToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<SshToolResult> {
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

    // strict:未知字段直接判失败(而非默默剥掉)，失败分支带 schema + hint 供自纠。
    const objSchema = z.strictObject(def.inputShape);
    const parsed = objSchema.safeParse(rawArgs ?? {});
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
                // received: 回显收到的顶层 keys — 只回 schema 时模型看不出自己是多包了一层信封
                // (keys=["args"]) 还是拍平了 (keys=参数字段), 实测 2026-10-31 三个会话因此连续盲试。
                received: rawArgs && typeof rawArgs === 'object'
                  ? Object.keys(rawArgs as Record<string, unknown>)
                  : [],
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
