/** Code Mode 生成工具调用源码时，自由文本参数必须遵守的稳定编码契约。 */
export const CODE_MODE_FREE_TEXT_GUIDANCE =
  'Code Mode 生成调用源码时，必须把正文编码成 JSON 字符串字面量（采用 JSON.stringify 的转义规则）再作为参数值；禁止把原文直接嵌入模板字符串，否则反引号、${...} 或代码块会在工具调用前导致 JavaScript 解析失败';
