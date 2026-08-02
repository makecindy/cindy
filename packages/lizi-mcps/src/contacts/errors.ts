/**
 * contacts/errors.ts — 把 maker-core ContactsError 翻译成 MCP tool result 错误码。
 *
 * 错误码集:
 *  - CONTACTS_NOT_READY : 功能未开启 / manager 未注入 / store 打开失败
 *  - NOT_FOUND          : contact / identity / event / group 不存在
 *  - ALREADY_EXISTS     : 身份已在本人名下 / 组名撞名
 *  - IDENTITY_CONFLICT  : (platform,value) 已属于另一个 contact — data 带 conflictContactId
 *  - INVALID_PARAMS     : 字段/格式/长度等业务校验失败
 *  - PERMISSION_DENIED  : 系统通讯录授权被拒(host 经 throwIpcError 的 [CODE] message 协议传入)
 *  - UNSUPPORTED_CAPABILITY : 当前平台不支持(如非 macOS 调系统通讯录)
 *  - INTERNAL           : 其他底层错
 */

import { ContactsError, type DuplicateCandidate } from '@cindy/maker-core';

export type ContactsToolErrorCode =
  | 'CONTACTS_NOT_READY'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'IDENTITY_CONFLICT'
  /** 名字/别名与既有档案相似 — data 带 candidates, 确认后 update 或 allow_duplicate 重试 */
  | 'DUPLICATE_SUSPECT'
  | 'INVALID_PARAMS'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INTERNAL';

export interface ContactsToolError {
  code: ContactsToolErrorCode;
  message: string;
  conflictContactId?: string;
  /** DUPLICATE_SUSPECT: 疑似同人候选列表 */
  candidates?: DuplicateCandidate[];
}

/**
 * contacts_create 查重拦截信号 — 走 throw 让 withContacts 统一收口成
 * DUPLICATE_SUSPECT 错误(带候选与处置 hint), 不污染 store 层语义。
 */
export class DuplicateSuspectSignal extends Error {
  constructor(public readonly candidates: DuplicateCandidate[]) {
    super(
      `possible duplicate of: ${candidates.map((c) => c.displayName).join(', ')} — ` +
        'confirm with contacts_get first; same person → contacts_update / contacts_add_identity, ' +
        'different person → retry with allow_duplicate:true',
    );
    this.name = 'DuplicateSuspectSignal';
  }
}

/** 把 unknown error 分类成结构化 {code, message}. 纯函数, 不抛 */
export function classifyContactsError(err: unknown): ContactsToolError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DuplicateSuspectSignal) {
    return { code: 'DUPLICATE_SUSPECT', message, candidates: err.candidates };
  }
  if (err instanceof ContactsError) {
    switch (err.code) {
      case 'not-found':
        return { code: 'NOT_FOUND', message };
      case 'already-exists':
        return { code: 'ALREADY_EXISTS', message };
      case 'identity-conflict':
        return {
          code: 'IDENTITY_CONFLICT',
          message,
          ...(err.conflictContactId ? { conflictContactId: err.conflictContactId } : {}),
        };
      case 'invalid-params':
        return { code: 'INVALID_PARAMS', message };
      case 'io-error':
        return { code: 'INTERNAL', message };
    }
  }
  // instanceof 失败兜底(打包/多副本场景): 按 message 前缀 "contacts:<code> " 归类
  const tag = message.match(/^contacts:([a-z-]+)\s/);
  if (tag) {
    if (tag[1] === 'not-found') return { code: 'NOT_FOUND', message };
    if (tag[1] === 'already-exists') return { code: 'ALREADY_EXISTS', message };
    if (tag[1] === 'identity-conflict') return { code: 'IDENTITY_CONFLICT', message };
    if (tag[1] === 'invalid-params') return { code: 'INVALID_PARAMS', message };
    if (tag[1] === 'unsupported-capability') {
      return { code: 'UNSUPPORTED_CAPABILITY', message };
    }
    if (tag[1] === 'io-error') return { code: 'INTERNAL', message };
  }
  // host 侧系统通讯录能力经 throwIpcError 的 "[CODE] message" 协议抛出(Electron 跨层
  // 会丢 Error.code 字段, message 前缀是唯一可靠载体), 这里按前缀还原成工具面错误码。
  // 覆盖 host 该能力实际会抛的全部 code — 漏列会让业务错误(如 INVALID_PARAMS)
  // 落进 INTERNAL 兜底, agent 拿到误导性错误码无法自纠
  const ipcTag = message.match(
    /^\[(PERMISSION_DENIED|UNSUPPORTED_CAPABILITY|INVALID_PARAMS|NOT_FOUND|INTERNAL)\]/,
  );
  if (ipcTag) {
    return { code: ipcTag[1] as ContactsToolErrorCode, message };
  }
  if (/manager not (?:available|ready|injected)|contacts disabled/i.test(message)) {
    return { code: 'CONTACTS_NOT_READY', message };
  }
  return { code: 'INTERNAL', message };
}
