/**
 * 手机读写同账号中转目录(格式与规则见 `@cindy/device-link` 的 relayAccountDirectory.ts,
 * 电脑端对应 apps/desktop/src/main/device-link/relayAccountPreferences.ts)。
 *
 * 记录在 Chat Server 账号私有的 preferences 里;请求不带 `X-Chat-Actor`,只读写本人账号。
 * 只在需要时请求:打开设置页时读一次目录;加入时写申请、在等待时间内轮询主人电脑回写的链接,
 * 用完就从账号里撤下。
 */
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  parseRelayAccountJoinBoard,
  parseRelayAccountOffers,
  parseRelayJoinLink,
  RELAY_ACCOUNT_ACK_WAIT_MS,
  RELAY_ACCOUNT_INVITE_WAIT_MS,
  RELAY_JOIN_PREFERENCE,
  RELAY_OFFERS_PREFERENCE,
  serializeRelayAccountJoinBoard,
  type RelayAccountJoinBoard,
  type RelayAccountOffer,
  type RelayJoinLink,
} from '@cindy/device-link';

import { useAuth } from '@/auth/AuthContext';
import { useChatClient } from '@/chat/useChatServer';
import { chatRejection, type ChatRequest } from '@/chat/chatServerClient';

const MAX_WRITE_ATTEMPTS = 4;
const INVITE_POLL_MS = 2_000;

export type RelayAccountJoinErrorCode = 'OWNER_UNAVAILABLE' | 'RELAY_UNAVAILABLE' | 'ACCOUNT_DIRECTORY_UNAVAILABLE';

export class RelayAccountJoinError extends Error {
  constructor(readonly code: RelayAccountJoinErrorCode) {
    super(code);
    this.name = 'RelayAccountJoinError';
  }
}

async function readPreference(request: ChatRequest, key: string, signal?: AbortSignal): Promise<{ value: unknown; revision: number }> {
  // `?key=` 只读这一条;旧版服务忽略它、返回全部记录,这里照样按 key 挑出来。
  const rows = await request<Array<{ key?: unknown; value?: unknown; revision?: unknown }>>(
    `/preferences?key=${encodeURIComponent(key)}`, 'GET', undefined, undefined, signal,
  );
  const row = Array.isArray(rows) ? rows.find((item) => item?.key === key) : undefined;
  return { value: row?.value ?? null, revision: typeof row?.revision === 'number' ? row.revision : 0 };
}

/** 读出当前值交给 `change`,它返回 false 表示不用改;与别的设备同时写入时按新值重来。 */
async function editJoinBoard(request: ChatRequest, change: (board: RelayAccountJoinBoard) => boolean): Promise<void> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const { value, revision } = await readPreference(request, RELAY_JOIN_PREFERENCE);
    const board = parseRelayAccountJoinBoard(value, Date.now());
    if (!change(board)) return;
    try {
      await request('/preferences', 'POST', {
        operationId: `relay.${randomUUID()}`,
        key: RELAY_JOIN_PREFERENCE,
        expectedRevision: revision,
        value: serializeRelayAccountJoinBoard(board),
      });
      return;
    } catch (error) {
      if (chatRejection(error, 409, 'REVISION_CONFLICT')) continue;
      throw error;
    }
  }
  throw new Error('REVISION_CONFLICT');
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/**
 * 加入同账号电脑的中转:登记这台手机事先生成的签名公钥,等那台电脑回写一次性链接。
 * 链接里的主人公钥必须与目录里那台电脑的一致;拿到后照常经中转加入,那台电脑核对公钥后自动放行。
 */
export async function requestRelayAccountInvite(input: {
  request: ChatRequest;
  offer: RelayAccountOffer;
  deviceId: string;
  deviceName: string;
  platform: string;
  publicKey: string;
  signal: AbortSignal;
}): Promise<RelayJoinLink> {
  const { request, offer, deviceId, signal } = input;
  const requestId = randomUUID();
  try {
    await editJoinBoard(request, (board) => {
      board.requests[deviceId] = {
        requestId, deviceId, deviceName: input.deviceName.slice(0, 128) || 'Cindy', platform: input.platform,
        relayId: offer.relayId, ownerDeviceId: offer.ownerDeviceId, publicKey: input.publicKey, createdAt: Date.now(),
      };
      delete board.invites[deviceId];
      return true;
    });
  } catch {
    throw new RelayAccountJoinError('ACCOUNT_DIRECTORY_UNAVAILABLE');
  }
  let invite: RelayAccountJoinBoard['invites'][string] | null = null;
  try {
    const started = Date.now();
    // 那台电脑在线时很快会先回一声「收到」;等不到就直接提示,不必等满。
    let acknowledged = false;
    while (!invite) {
      const waited = Date.now() - started;
      if (waited > RELAY_ACCOUNT_INVITE_WAIT_MS || (!acknowledged && waited > RELAY_ACCOUNT_ACK_WAIT_MS)) {
        throw new RelayAccountJoinError('OWNER_UNAVAILABLE');
      }
      await wait(INVITE_POLL_MS, signal);
      try {
        const found = parseRelayAccountJoinBoard((await readPreference(request, RELAY_JOIN_PREFERENCE, signal)).value, Date.now())
          .invites[deviceId];
        if (found?.requestId === requestId) {
          if (found.pending) acknowledged = true;
          else invite = found;
        }
      } catch {
        if (signal.aborted) throw new Error('aborted');
        // 暂时读不到:接着等,到时间再报那台电脑没回应。
      }
    }
  } finally {
    // 申请和回写的链接用完就撤下,账号里不留一次性链接。
    void editJoinBoard(request, (board) => {
      let changed = false;
      if (board.requests[deviceId]?.requestId === requestId) { delete board.requests[deviceId]; changed = true; }
      if (board.invites[deviceId]?.requestId === requestId) { delete board.invites[deviceId]; changed = true; }
      return changed;
    }).catch(() => undefined);
  }
  if (!invite) throw new RelayAccountJoinError('OWNER_UNAVAILABLE');
  const link = invite.link ? parseRelayJoinLink(invite.link) : null;
  if (invite.error || !link || link.ownerPublicKey !== offer.ownerPublicKey) throw new RelayAccountJoinError('RELAY_UNAVAILABLE');
  return link;
}

/** 同账号电脑正在用的中转:设置页每次获得焦点时读一次;读不到时保留上次的结果。 */
export function useRelayAccountOffers(): RelayAccountOffer[] {
  const chat = useChatClient();
  const { deviceId } = useAuth();
  const [offers, setOffers] = useState<RelayAccountOffer[]>([]);
  const owner = chat.owner;

  useEffect(() => {
    setOffers([]);
  }, [owner]);

  const load = useCallback(() => {
    if (!chat.enabled) return undefined;
    let active = true;
    void readPreference(chat.request, RELAY_OFFERS_PREFERENCE)
      .then(({ value }) => {
        if (active && chat.current()) setOffers(parseRelayAccountOffers(value));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [chat]);

  useFocusEffect(load);
  return offers.filter((offer) => offer.ownerDeviceId !== deviceId);
}
