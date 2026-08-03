/** Git 引用（branch / tag / commit）允许的字符集；拒绝选项注入（- 开头）与路径穿越。 */
const GIT_REF_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function isValidGitRef(value: string): boolean {
  return GIT_REF_PATTERN.test(value);
}
