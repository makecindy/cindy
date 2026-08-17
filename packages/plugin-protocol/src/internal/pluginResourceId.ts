/** 判断值是否符合 plugin-server 当前使用的 Plugin 资源 ID 形状。 */
export function isValidPluginResourceId(value: unknown): value is string {
  return typeof value === 'string' && /^c[a-z0-9]{24}$/.test(value);
}
