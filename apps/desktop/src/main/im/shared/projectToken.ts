/**
 * `/project` 切换卡按钮里代表一个项目的不透明标记。
 *
 * 卡片按钮的数据会原样存到 IM 平台(飞书把它序列化进按钮的 value), 所以不能带本机绝对路径 ——
 * 那会把用户名、仓库名这些信息上传出去。按钮只带这个标记, 回调时再按当前的项目清单找回目录;
 * 清单里已经没有这个项目(被移除、目录换了)就找不到, 切换按失败收口。
 */

import { createHash } from 'node:crypto';

export function projectToken(workingDir: string): string {
  return createHash('sha256').update(workingDir, 'utf8').digest('hex').slice(0, 24);
}
