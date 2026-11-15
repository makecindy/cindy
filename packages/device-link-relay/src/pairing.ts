/**
 * 加入流程:主人生成一次性加入码 → 新设备凭加入码提交申请 → 主人在自己的电脑上核对并同意 →
 * 新设备凭申请时拿到的轮询口令取回凭证(只给一次)。
 *
 * - 加入码 256 位随机,只存哈希,10 分钟有效,提交一次即作废。
 * - 账号不一致直接拒绝(跨账号走共享任务 / 供应商分享);这只防误操作,准入关口是主人同意。
 * - 设备在取回凭证的那一刻才写入设备档案:同意后没人来取,就不会留下一个没人持有凭证的设备。
 * - 申请带新设备的签名公钥与配对证明(用加入链接里的配对秘密算出,中转拿不到秘密);主人电脑核对证明后
 *   签发证书随同意一起交给中转,中转只核对证书确实出自主人、发给的就是申请里这把公钥。
 * - 全部状态在内存里;中转重启后未完成的申请作废,重新生成加入码即可。
 */
import { randomUUID } from 'node:crypto';
import {
  createDeviceCredential,
  createSecret,
  createVerifyCode,
  hashSecret,
  safeEqualHex,
} from './credentials';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';
import { isRelayPublicKey, verifyRelayDeviceCert, type RelayDeviceCert } from '@cindy/device-link/relay-auth';
import { RelayError } from './errors';
import { DEVICE_ID_PATTERN, normalizeName, type RelayStore, type StoredDevice } from './store';

export const JOIN_CODE_TTL_MS = 10 * 60 * 1000;
const PAIR_REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_JOIN_CODES = 5;
const MAX_PENDING_REQUESTS = 5;
const SUBMIT_WINDOW_MS = 10 * 60 * 1000;
const MAX_SUBMITS_PER_SOURCE = 20;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type PairStatus = 'pending' | 'approved' | 'rejected';

interface PairRequest {
  requestId: string;
  pollTokenHash: string;
  deviceId: string;
  deviceName: string;
  platform: string | null;
  appVersion: string | null;
  publicKey: string;
  proof: string;
  verifyCode: string;
  createdAt: number;
  expiresAt: number;
  status: PairStatus;
  cert?: RelayDeviceCert;
}

export interface PairRequestView {
  requestId: string;
  deviceId: string;
  deviceName: string;
  platform: string | null;
  appVersion: string | null;
  /** 新设备的签名公钥与配对证明:主人电脑用加入链接里的配对秘密核对,通过才签发证书。 */
  publicKey: string;
  proof: string;
  verifyCode: string;
  createdAt: string;
  expiresAt: string;
  /** 同一设备之前已加入过(例如重装),同意后旧凭证失效。 */
  replacesExisting: boolean;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'rejected' }
  | { status: 'expired' }
  | { status: 'approved'; credential: string; deviceId: string; cert: RelayDeviceCert };

function optionalShortString(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw new RelayError('BAD_REQUEST', 'invalid field');
  return value;
}

export class Pairing {
  private readonly joinCodes = new Map<string, number>();
  private readonly requests = new Map<string, PairRequest>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly submitsBySource = new Map<string, number[]>();

  constructor(
    private readonly store: RelayStore,
    private readonly now: () => number,
    private readonly onAdmitted: (device: StoredDevice) => void,
  ) {}

  createJoinCode(): { code: string; expiresAt: string } {
    this.expire();
    if (this.joinCodes.size >= MAX_ACTIVE_JOIN_CODES) {
      throw new RelayError('RATE_LIMITED', 'too many active join codes');
    }
    const code = createSecret();
    const expiresAt = this.now() + JOIN_CODE_TTL_MS;
    this.joinCodes.set(hashSecret(code), expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  submit(body: Record<string, unknown>, source: string): { requestId: string; pollToken: string; verifyCode: string } {
    this.expire();
    this.limitSource(source);
    const { code, deviceId, accountUserId } = body;
    const deviceName = normalizeName(body.deviceName);
    if (typeof code !== 'string' || typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId) || !deviceName) {
      throw new RelayError('BAD_REQUEST', 'invalid pairing request');
    }
    if (!isRelayPublicKey(body.publicKey) || typeof body.proof !== 'string' || !PROOF_PATTERN.test(body.proof)) {
      throw new RelayError('BAD_REQUEST', 'this Cindy version is too old to join a signed relay');
    }
    const platform = optionalShortString(body.platform, 32);
    const appVersion = optionalShortString(body.appVersion, 64);
    const codeHash = hashSecret(code);
    const codeExpiresAt = this.joinCodes.get(codeHash);
    if (codeExpiresAt === undefined || codeExpiresAt < this.now()) {
      throw new RelayError('FORBIDDEN', 'invalid or expired join code');
    }
    // 账号不对时保留加入码,让正确的设备还能用。
    if (accountUserId !== this.store.ownerUserId) {
      throw new RelayError('ACCOUNT_MISMATCH', 'this relay belongs to another Cindy account');
    }
    if (this.store.get(deviceId)?.role === 'owner') {
      throw new RelayError('FORBIDDEN', 'the owner device is already part of this relay');
    }
    const pending = [...this.requests.values()].filter((request) => request.status === 'pending');
    if (pending.length >= MAX_PENDING_REQUESTS) throw new RelayError('RATE_LIMITED', 'too many pending requests');

    this.joinCodes.delete(codeHash);
    const pollToken = createSecret();
    const createdAt = this.now();
    const request: PairRequest = {
      requestId: randomUUID(),
      pollTokenHash: hashSecret(pollToken),
      deviceId,
      deviceName,
      platform,
      appVersion,
      publicKey: body.publicKey,
      proof: body.proof,
      verifyCode: createVerifyCode(),
      createdAt,
      expiresAt: createdAt + PAIR_REQUEST_TTL_MS,
      status: 'pending',
    };
    this.requests.set(request.requestId, request);
    return { requestId: request.requestId, pollToken, verifyCode: request.verifyCode };
  }

  listPending(): PairRequestView[] {
    this.expire();
    return [...this.requests.values()]
      .filter((request) => request.status === 'pending')
      .map((request) => ({
        requestId: request.requestId,
        deviceId: request.deviceId,
        deviceName: request.deviceName,
        platform: request.platform,
        appVersion: request.appVersion,
        publicKey: request.publicKey,
        proof: request.proof,
        verifyCode: request.verifyCode,
        createdAt: new Date(request.createdAt).toISOString(),
        expiresAt: new Date(request.expiresAt).toISOString(),
        replacesExisting: this.store.get(request.deviceId) !== undefined,
      }));
  }

  /** 同意时必须附主人为申请里这把公钥签发的证书。 */
  decide(requestId: string, approve: boolean, rawCert?: unknown): void {
    this.expire();
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') throw new RelayError('NOT_FOUND', 'pairing request not found');
    if (approve) {
      const cert = verifyRelayDeviceCert(nodeRelayAuthCrypto, this.store.ownerPublicKey, this.store.relayId, rawCert);
      if (!cert || cert.deviceId !== request.deviceId || cert.publicKey !== request.publicKey || cert.role !== 'member') {
        throw new RelayError('BAD_REQUEST', 'approval requires a certificate for the requesting device');
      }
      request.cert = cert;
    }
    request.status = approve ? 'approved' : 'rejected';
    // 同意后给取回留一个完整的有效期,避免主人刚好在快过期时点同意。
    request.expiresAt = this.now() + PAIR_REQUEST_TTL_MS;
    this.wake(requestId);
  }

  /** 长轮询:等到主人决定或超时。凭证只返回一次,随后申请即被删除。 */
  async poll(requestId: string, pollToken: unknown, waitMs: number): Promise<PollResult> {
    const request = this.authorizePoll(requestId, pollToken);
    if (!request) return { status: 'expired' };
    if (request.status === 'pending' && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        const set = this.waiters.get(requestId) ?? new Set();
        this.waiters.set(requestId, set);
        function done() {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        }
        set.add(done);
      });
    }
    this.expire();
    const current = this.requests.get(requestId);
    if (!current) return { status: 'expired' };
    if (current.status === 'pending') return { status: 'pending' };
    this.requests.delete(requestId);
    if (current.status === 'rejected') return { status: 'rejected' };
    const { credential, credentialHash } = createDeviceCredential();
    const device = this.store.admitMember({
      deviceId: current.deviceId,
      credentialHash,
      cert: current.cert!,
      reportedName: current.deviceName,
      platform: current.platform,
      appVersion: current.appVersion,
      now: this.now(),
    });
    this.onAdmitted(device);
    return { status: 'approved', credential, deviceId: device.deviceId, cert: device.cert };
  }

  /** 关闭中转时唤醒所有长轮询,让它们按当前状态返回。 */
  wakeAll(): void {
    for (const requestId of [...this.waiters.keys()]) this.wake(requestId);
  }

  private authorizePoll(requestId: string, pollToken: unknown): PairRequest | null {
    this.expire();
    const request = this.requests.get(requestId);
    if (!request) return null;
    if (typeof pollToken !== 'string' || !safeEqualHex(hashSecret(pollToken), request.pollTokenHash)) {
      throw new RelayError('FORBIDDEN', 'invalid poll token');
    }
    return request;
  }

  private wake(requestId: string): void {
    const set = this.waiters.get(requestId);
    if (!set) return;
    this.waiters.delete(requestId);
    for (const done of [...set]) done();
  }

  private limitSource(source: string): void {
    const now = this.now();
    const recent = (this.submitsBySource.get(source) ?? []).filter((at) => now - at < SUBMIT_WINDOW_MS);
    if (recent.length >= MAX_SUBMITS_PER_SOURCE) {
      this.submitsBySource.set(source, recent);
      throw new RelayError('RATE_LIMITED', 'too many pairing attempts');
    }
    recent.push(now);
    this.submitsBySource.set(source, recent);
  }

  private expire(): void {
    const now = this.now();
    for (const [hash, expiresAt] of this.joinCodes) if (expiresAt < now) this.joinCodes.delete(hash);
    for (const [requestId, request] of this.requests) {
      if (request.expiresAt < now) {
        this.requests.delete(requestId);
        this.wake(requestId);
      }
    }
    for (const [source, times] of this.submitsBySource) {
      if (times.every((at) => now - at >= SUBMIT_WINDOW_MS)) this.submitsBySource.delete(source);
    }
  }
}
