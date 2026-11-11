/**
 * OpenAI 式 strict function-tool 的 schema 兼容性判定(fail-closed)。
 *
 * strict 约束解码只接受一个受限 JSON Schema 子集:对象节点必须
 * `additionalProperties:false` 且**所有** property 进 `required`,关键字限于少数白名单。
 * Claude Code 内置工具(如 Edit 的可选 replace_all)和复杂 MCP schema
 * (propertyNames / maxItems / oneOf …)普遍不满足。
 *
 * 判定取保守面:任何未知关键字、未覆盖形态一律判不兼容,由调用方回落 strict:false。
 * 回落只是少一层约束(与现状一致),误开 strict 才有上游 400 / 语义漂移风险;
 * 因此**不做 optional→nullable 的 schema 改写**,不改变工具语义。
 *
 * 结果是 schema 内容的纯函数:同一会话内工具集稳定 ⇒ 每轮各工具的 strict 位稳定,
 * 不破坏请求前缀一致性(docs/dev-rules/maker-core-and-agent-behavior.md §3.1)。
 */

/** strict 子集允许的 schema 关键字。白名单外(pattern/format/oneOf/propertyNames…)一律不兼容。 */
const ALLOWED_KEYS = new Set([
  'type',
  'description',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
]);

const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** 递归深度上限:防御性边界,真实工具 schema 远达不到;超深直接判不兼容。 */
const MAX_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 该 function-tool 参数 schema 是否可以安全地声明 `strict: true`。
 * 根节点必须是 `type:'object'`(Responses function parameters 的硬要求)。
 */
export function isStrictCompatibleSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  if (schema.type !== 'object') return false;
  return nodeOk(schema, MAX_DEPTH);
}

function nodeOk(node: Record<string, unknown>, depth: number): boolean {
  if (depth <= 0) return false;
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYS.has(key)) return false;
  }

  // anyOf 节点:只能与 description 共存,分支各自校验(strict 子集不支持 anyOf 与
  // type/properties 等结构字段同级混写)。
  if (node.anyOf !== undefined) {
    for (const key of Object.keys(node)) {
      if (key !== 'anyOf' && key !== 'description') return false;
    }
    if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) return false;
    return node.anyOf.every((branch) => isPlainObject(branch) && nodeOk(branch, depth - 1));
  }

  const types = typeList(node.type);
  if (!types) return false;

  if (types.includes('object')) {
    if (node.additionalProperties !== false) return false;
    if (!isPlainObject(node.properties)) return false;
    const propertyKeys = Object.keys(node.properties).sort();
    // required 必须**恰好**覆盖全部 property(缺一个 = 存在 optional 字段,不兼容;
    // 多一个 = required 指向不存在的字段,同样不兼容)。
    if (!Array.isArray(node.required)) return false;
    const required = node.required.filter((item): item is string => typeof item === 'string');
    if (required.length !== node.required.length) return false;
    const sortedRequired = [...required].sort();
    if (
      sortedRequired.length !== propertyKeys.length
      || sortedRequired.some((key, index) => key !== propertyKeys[index])
    ) {
      return false;
    }
    for (const value of Object.values(node.properties)) {
      if (!isPlainObject(value) || !nodeOk(value, depth - 1)) return false;
    }
  } else if (
    node.properties !== undefined
    || node.required !== undefined
    || node.additionalProperties !== undefined
  ) {
    return false;
  }

  if (types.includes('array')) {
    if (!isPlainObject(node.items) || !nodeOk(node.items, depth - 1)) return false;
  } else if (node.items !== undefined) {
    return false;
  }

  // enum/const 的成员是任意 JSON 值,strict 子集接受,成员内容无需校验;
  // 但空 enum 连普通 grammar 编译都会被上游 400(docs.x.ai structured-outputs),判不合规。
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) return false;
  return true;
}

/** type 归一化:字符串或字符串数组(nullable 联合如 ['string','null']),全部落在允许集合内。 */
function typeList(type: unknown): string[] | null {
  const raw = typeof type === 'string' ? [type] : Array.isArray(type) ? type : null;
  if (!raw || raw.length === 0) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !ALLOWED_TYPES.has(entry)) return null;
    out.push(entry);
  }
  return out;
}
