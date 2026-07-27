/**
 * JSON Schema draft-07 的**受限子集**校验器,零依赖。
 *
 * 为什么不用 ajv:本仓 scripts/ 一贯只用 node 内置模块(唯一例外是 ws)。ajv 目前能在
 * 根 node_modules 里解析到,但它只是别的包提升上来的传递依赖——把 CI 阻断门禁架在
 * 「碰巧被提升」的包上,lockfile 一变就会静默失效。
 *
 * 安全前提:**遇到不认识的关键字立即抛错**(compile 阶段),而不是忽略。
 * 子集校验器最危险的失败模式是「schema 写了约束、校验器看不懂、于是默默放行」——
 * 那正是本模块要解决的问题本身。宁可让加新关键字的人被迫来这里补实现。
 */

/**
 * 本模块实现的关键字。不在此列的一律报错,详见文件头。
 *
 * 其中 $schema / $id / title / description 是纯注解,不产生约束;definitions 只被
 * $ref 解引用时用到。它们列在这里是为了让 assertSupported 放行,校验逻辑本身
 * 不需要看它们。
 */
const SUPPORTED = new Set([
  '$schema',
  '$id',
  '$ref',
  'title',
  'description',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'enum',
  'pattern',
  'minItems',
  'minLength',
  'oneOf',
  'definitions',
]);

/**
 * 每个关键字的值必须是什么形状。
 *
 * 只查「关键字名认不认得」是不够的:形状写错时,校验器会以自己那套(而非 JSON Schema 的)
 * 方式去解释它,约束就变成了别的意思——这恰恰违背本模块「不静默忽略」的安全前提。
 * 典型的是 `type: ["string", "null"]`(draft-07 合法),本实现只支持字符串形态,
 * 拿数组去比对会永远不等,于是那条 type 约束在「看似生效」的外表下彻底失效。
 */
const KEYWORD_SHAPE = {
  type: 'string',
  pattern: 'string',
  $ref: 'string',
  $schema: 'string',
  $id: 'string',
  title: 'string',
  description: 'string',
  minItems: 'number',
  minLength: 'number',
  required: 'array',
  enum: 'array',
  oneOf: 'array',
  properties: 'object',
  definitions: 'object',
};

/**
 * 值本身是一个 schema 的关键字。
 *
 * 这些位置允许 boolean schema(draft-07 里 `true` 恒通过、`false` 恒失败),
 * 所以不能按 'object' 死判——那会把合法的 `items: false` 误判成 schema 写错。
 * 其余关键字(type / required / …)仍按 KEYWORD_SHAPE 严格校验。
 */
const SCHEMA_VALUED = new Set(['items', 'additionalProperties']);

function shapeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** 递归检查 schema 自身只用了已实现的关键字,且每个关键字的值形状也在支持范围内。 */
function assertSupported(node, path = '#') {
  if (node === true || node === false) return;
  if (typeof node !== 'object' || node === null) {
    throw new Error(`schema ${path} 不是对象`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (!SUPPORTED.has(key)) {
      throw new Error(
        `schema ${path} 使用了未实现的关键字 "${key}"——请在 scripts/shared/json-schema-lite.mjs 里补上实现,` +
          '不要让它被静默忽略',
      );
    }
    if (SCHEMA_VALUED.has(key)) {
      if (typeof value !== 'boolean' && shapeOf(value) !== 'object') {
        throw new Error(
          `schema ${path}/${key} 只支持 boolean 或 schema 对象,实际是 ${shapeOf(value)}`,
        );
      }
      continue;
    }
    const expected = KEYWORD_SHAPE[key];
    if (expected && shapeOf(value) !== expected) {
      throw new Error(
        `schema ${path} 的 "${key}" 应是 ${expected},实际是 ${shapeOf(value)}——` +
          '本模块只实现了 JSON Schema 的一个子集,形状不符时约束会被错误解释而非报错',
      );
    }
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    assertSupported(child, `${path}/properties/${key}`);
  }
  for (const [key, child] of Object.entries(node.definitions ?? {})) {
    assertSupported(child, `${path}/definitions/${key}`);
  }
  if (typeof node.additionalProperties === 'object') {
    assertSupported(node.additionalProperties, `${path}/additionalProperties`);
  }
  if (node.items !== undefined) assertSupported(node.items, `${path}/items`);
  for (const [i, child] of (node.oneOf ?? []).entries()) {
    assertSupported(child, `${path}/oneOf/${i}`);
  }
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  // integer / number 单独判:typeOf 把整数报成 'integer',直接比对会让 `type: "number"`
  // 拒掉整数值。
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number';
  return typeOf(value) === expected;
}

/**
 * 校验 value 是否符合 schema,返回错误信息数组(空数组＝通过)。
 * root 用于解析 `$ref`,只支持 `#/definitions/X` 这一种形态——够用,且不引入
 * 远程引用这类需要网络的能力。
 */
function validateNode(value, schema, root, path, errors) {
  // boolean schema 是合法 draft-07:true 恒通过,false 恒失败。
  // assertSupported 已经放行它们,这里若不处理,`schema.$ref`/`schema.type` 全是 undefined,
  // false 就被当成「无约束对象」——`items: false` 变成不检查,`oneOf` 里的 false 分支
  // 甚至能算作唯一通过的分支,把本意「禁止一切」的约束翻转成「允许一切」。
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path}: schema 为 false,此处不允许任何值`);
    return;
  }

  if (schema.$ref) {
    const m = /^#\/definitions\/([^/]+)$/.exec(schema.$ref);
    if (!m) throw new Error(`只支持 #/definitions/X 形式的 $ref,收到 ${schema.$ref}`);
    const target = root.definitions?.[m[1]];
    if (!target) throw new Error(`$ref 指向不存在的定义:${schema.$ref}`);
    validateNode(value, target, root, path, errors);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: 期望 ${schema.type},实际 ${typeOf(value)}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: 取值必须是 ${schema.enum.join(' / ')} 之一,实际 ${JSON.stringify(value)}`);
  }

  if (typeof value === 'string') {
    if (schema.pattern) {
      // schema 里的 pattern 写坏时,new RegExp 会抛出去、整个校验流程中断,调用方拿不到
      // 带 path 的可读错误(check-i18n-glossary 会直接崩栈而不是走 fail())。
      // 转成普通校验错误,并明确指向是 schema 自身的问题而非数据的问题。
      let re;
      try {
        re = new RegExp(schema.pattern);
      } catch (err) {
        errors.push(`${path}: schema 的 pattern 不是合法正则(${schema.pattern}):${err.message}`);
        re = null;
      }
      if (re && !re.test(value)) {
        errors.push(`${path}: "${value}" 不匹配 ${schema.pattern}`);
      }
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: 长度需 ≥ ${schema.minLength}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: 至少需要 ${schema.minItems} 项`);
    }
    // 必须判 !== undefined:`items: false` 是合法 draft-07(禁止任何元素),
    // 但它是 falsy,写 `if (schema.items)` 会把这条约束整个跳过。
    if (schema.items !== undefined) {
      value.forEach((item, i) => validateNode(item, schema.items, root, `${path}[${i}]`, errors));
    }
  }

  if (schema.oneOf) {
    const passed = schema.oneOf.filter((branch) => {
      const sub = [];
      validateNode(value, branch, root, path, sub);
      return sub.length === 0;
    });
    if (passed.length !== 1) {
      errors.push(`${path}: 需恰好匹配 oneOf 的一个分支,实际匹配 ${passed.length} 个`);
    }
  }

  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: 缺少必填字段 "${key}"`);
    }
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (known.has(key)) {
        validateNode(child, schema.properties[key], root, childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(
          `${childPath}: 未知字段 "${key}"——拼错的字段名(如 forbiden)会让整条规则静默失效`,
        );
      } else if (typeof schema.additionalProperties === 'object') {
        validateNode(child, schema.additionalProperties, root, childPath, errors);
      }
    }
  }
}

/** 校验 data 是否符合 schema。返回人读错误信息数组,空数组＝通过。 */
export function validateAgainstSchema(data, schema) {
  assertSupported(schema);
  const errors = [];
  validateNode(data, schema, schema, '$', errors);
  return errors;
}
