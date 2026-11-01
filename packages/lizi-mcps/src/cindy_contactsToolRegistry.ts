/**
 * cindy_contactsToolRegistry.ts
 * ---------------------------------------------------------------------------
 * Mirror of MemoryToolRegistry — 智能通讯录工具注册表, 保持 entry-tool 面只有
 * list_tools + call_tool (token economy)。
 *
 * Categories:
 *  - search : contacts_resolve / contacts_search   (身份反查 + 全文检索, 最高频)
 *  - read   : contacts_get / contacts_list / contacts_list_groups / contacts_stats
 *  - write  : contacts_create / contacts_update / contacts_add_identity /
 *             contacts_remove_identity / contacts_append_event  (agent 日常自主可用)
 *  - manage : contacts_delete / contacts_merge / 分组 CRUD 与成员管理
 *             (破坏性/组织性操作, 仅在用户明确指示时使用 — 边界写在工具 rules 里)
 */

import { z } from 'zod';

export type ContactsToolCategory = 'search' | 'read' | 'write' | 'manage';

export type ContactsToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ContactsToolResult {
  content: ContactsToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type ContactsToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<ContactsToolResult>;

export interface ContactsToolDef {
  name: string;
  category: ContactsToolCategory;
  description: string;
  rules?: string[];
  inputShape: z.ZodRawShape;
  handler: ContactsToolHandler;
}

export interface ContactsToolSummary {
  name: string;
  category: ContactsToolCategory;
  description: string;
  rules?: string[];
}

export class ContactsToolRegistry {
  private readonly tools = new Map<string, ContactsToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: ContactsToolCategory;
    description: string;
    rules?: string[];
    inputShape: T;
    handler: ContactsToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[cindy_contactsToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as ContactsToolDef);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ContactsToolDef | undefined {
    return this.tools.get(name);
  }

  list(category?: ContactsToolCategory): ContactsToolSummary[] {
    const all: ContactsToolSummary[] = [];
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

  listCategories(): ContactsToolCategory[] {
    const set = new Set<ContactsToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<ContactsToolResult> {
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

    // strict: 未知字段直接判失败(而非默默剥掉), 失败分支带 schema + hint 供自纠。
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
