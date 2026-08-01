/**
 * send_to_session create 模式的 working_dir 覆盖校验(#811)。
 *
 * 只做存在性与形状校验(绝对路径 + 已存在目录):调用方 agent 本就拥有本机文件
 * 访问面,目录选择不构成新增权限;校验的目的是把「目录写错」在创建 session 之前
 * 拦下来,给出可行动的错误,而不是让新 session 落在不存在的目录里静默失败。
 */

import fs from 'node:fs';
import path from 'node:path';

export type HandoffWorkingDirValidation =
  | { ok: true; dir: string }
  | { ok: false; message: string };

/**
 * 校验并规范化 working_dir 覆盖。通过时返回规范化后的目录(trim + resolve,
 * 调用方必须使用它,不要再用原始输入);失败时 message 进 INVALID_ARGS。
 */
export async function validateHandoffWorkingDir(
  rawDir: string,
): Promise<HandoffWorkingDirValidation> {
  const trimmed = typeof rawDir === 'string' ? rawDir.trim() : '';
  if (trimmed.length === 0) {
    return { ok: false, message: 'working_dir 不能为空' };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, message: `working_dir 必须是绝对路径:${trimmed}` };
  }
  // realpath 消解软链(review 反馈):软链落在某个受管 worktree 树内、真身却指向
  // 别的仓库时,后续 base repo 解析必须看真身;realpath 同时兜住存在性。
  let dir: string;
  try {
    dir = await fs.promises.realpath(path.resolve(trimmed));
  } catch {
    return { ok: false, message: `working_dir 不存在或不可访问:${path.resolve(trimmed)}` };
  }
  try {
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) return { ok: false, message: `working_dir 不是目录:${dir}` };
  } catch {
    return { ok: false, message: `working_dir 不存在或不可访问:${dir}` };
  }
  return { ok: true, dir };
}
