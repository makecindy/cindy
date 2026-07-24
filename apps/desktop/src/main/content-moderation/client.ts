import {
  MODERATION_JSON_SIGN_PATH,
  MODERATION_SUBMIT_LOGICAL_PATH,
  MODERATION_UPLOAD_SIGN_PATH,
  parseModerationSignedJsonResponse,
  parseModerationSignedUploadResponse,
  type ModerationBusinessCode,
  type ModerationItem,
  type ModerationJsonSignRequest,
  type ModerationSignedJsonResponse,
  type ModerationSignedUploadResponse,
  type ModerationSubmitBody,
} from '@cindy/content-moderation-protocol';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('content-moderation');
const QUERY_PATH = '/api/v1/review/tasks';
const QUERY_INTERVAL_MS = 1_000;
const MAX_QUERY_COUNT = 3;

export type { ModerationBusinessCode, ModerationItem } from '@cindy/content-moderation-protocol';

export type ModerationDecision = 'allow' | 'reject' | 'cancelled';

interface ReviewInput {
  signBaseUrl: string;
  accessToken: string;
  membershipId: string;
  businessCode: ModerationBusinessCode;
  dataId: string;
  items: ModerationItem[];
  extra?: {
    scene?: string;
    agentKind?: string;
    modelId?: string;
  };
  deadlineMs: number;
  signal?: AbortSignal;
}

interface UploadInput {
  signBaseUrl: string;
  accessToken: string;
  filePath: string;
  mimeType: string;
  deadlineAt: number;
  signal?: AbortSignal;
}

interface UploadBytesInput {
  signBaseUrl: string;
  accessToken: string;
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  deadlineAt: number;
  signal?: AbortSignal;
}

interface TimedSignal {
  signal: AbortSignal;
  deadlineReached(): boolean;
  dispose(): void;
}

function joinedUrl(baseUrl: string, logicalPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${logicalPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function knownStatus(value: unknown): value is 1 | 2 | 3 | 4 {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function decisionForStatus(status: 1 | 2 | 3 | 4): ModerationDecision | 'waiting' {
  if (status === 1) return 'waiting';
  if (status === 3) return 'reject';
  return 'allow';
}

function timedSignal(deadlineMs: number, callerSignal?: AbortSignal): TimedSignal {
  const controller = new AbortController();
  let deadline = false;
  const timer = setTimeout(() => {
    deadline = true;
    controller.abort();
  }, Math.max(0, deadlineMs));
  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (callerSignal?.aborted) controller.abort();
  return {
    signal: controller.signal,
    deadlineReached: () => deadline,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function jsonResponse(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export class ModerationClient {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Product contract: only an explicit REJECTED verdict blocks the operation.
   * Signing, transport, malformed-response and polling-exhaustion failures are
   * infrastructure failures and deliberately fail open within the caller's
   * bounded deadline.
   */
  async review(input: ReviewInput): Promise<ModerationDecision> {
    if (input.items.length === 0) return 'allow';
    const timer = timedSignal(input.deadlineMs, input.signal);
    const startedAt = this.now();
    let queryCount = 0;
    try {
      const requestBody: ModerationSubmitBody = {
        business_code: input.businessCode,
        data_id: input.dataId,
        items: input.items,
        user_info: { user_id: input.membershipId },
        ...(input.extra ? { extra: input.extra } : {}),
      };
      const body = JSON.stringify(requestBody);
      const signed = await this.requestJsonSignature(
        input.signBaseUrl,
        input.accessToken,
        body,
        timer.signal,
      );
      if (!signed) return 'allow';
      const submit = await this.fetchImpl(
        joinedUrl(signed.gateway_base_url, signed.logical_path),
        {
          method: 'POST',
          headers: { ...signed.headers },
          body,
          signal: timer.signal,
        },
      );
      const submitBody = await jsonResponse(submit);
      const submitData = submitBody && isRecord(submitBody.data) ? submitBody.data : null;
      const submitStatus = submitData?.status;
      const taskToken = submitData?.task_token;
      if (
        submit.status !== 201
        || submitBody?.code !== 200
        || !knownStatus(submitStatus)
        || !nonEmptyString(taskToken)
      ) {
        return 'allow';
      }
      const immediate = decisionForStatus(submitStatus);
      if (immediate !== 'waiting') return immediate;

      for (let index = 0; index < MAX_QUERY_COUNT; index += 1) {
        await sleep(QUERY_INTERVAL_MS, timer.signal);
        queryCount += 1;
        const response = await this.fetchImpl(
          joinedUrl(signed.gateway_base_url, QUERY_PATH),
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${taskToken}` },
            signal: timer.signal,
          },
        );
        const queryBody = await jsonResponse(response);
        const queryData = queryBody && isRecord(queryBody.data) ? queryBody.data : null;
        const status = queryData?.status;
        if (response.status !== 200 || queryBody?.code !== 200 || !knownStatus(status)) {
          return 'allow';
        }
        const decision = decisionForStatus(status);
        if (decision !== 'waiting') return decision;
      }
      return 'allow';
    } catch (error) {
      if (input.signal?.aborted && !timer.deadlineReached()) return 'cancelled';
      log.warn('moderation review failed open', {
        businessCode: input.businessCode,
        queryCount,
        elapsedMs: this.now() - startedAt,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return 'allow';
    } finally {
      timer.dispose();
    }
  }

  async uploadLocalImage(input: UploadInput): Promise<string | null> {
    try {
      const bytes = await fs.readFile(input.filePath);
      return await this.uploadImageBytes({
        signBaseUrl: input.signBaseUrl,
        accessToken: input.accessToken,
        bytes,
        fileName: path.basename(input.filePath),
        mimeType: input.mimeType,
        deadlineAt: input.deadlineAt,
        signal: input.signal,
      });
    } catch {
      return null;
    }
  }

  async uploadImageBytes(input: UploadBytesInput): Promise<string | null> {
    const remaining = input.deadlineAt - this.now();
    if (remaining <= 0) return null;
    const timer = timedSignal(remaining, input.signal);
    try {
      const signedResponse = await this.fetchImpl(
        joinedUrl(input.signBaseUrl, MODERATION_UPLOAD_SIGN_PATH),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
          signal: timer.signal,
        },
      );
      const signedBody = await jsonResponse(signedResponse);
      const signed = this.parseSignedUpload(signedResponse, signedBody);
      if (!signed) return null;
      const bytes = new Uint8Array(input.bytes.byteLength);
      bytes.set(input.bytes);
      const form = new FormData();
      form.append(
        'file',
        new Blob([bytes.buffer], { type: input.mimeType || 'application/octet-stream' }),
        input.fileName,
      );
      const uploadUrl = new URL(joinedUrl(signed.gateway_base_url, signed.logical_path));
      uploadUrl.searchParams.set('folder', signed.query.folder);
      const response = await this.fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { ...signed.headers },
        body: form,
        signal: timer.signal,
      });
      const body = await jsonResponse(response);
      const data = body && isRecord(body.data) ? body.data : null;
      return response.status === 201 && body?.code === 200 && nonEmptyString(data?.file_url)
        ? data.file_url
        : null;
    } catch {
      return null;
    } finally {
      timer.dispose();
    }
  }

  private async requestJsonSignature(
    signBaseUrl: string,
    accessToken: string,
    body: string,
    signal: AbortSignal,
  ): Promise<ModerationSignedJsonResponse | null> {
    const signRequest: ModerationJsonSignRequest = {
      logical_path: MODERATION_SUBMIT_LOGICAL_PATH,
      body,
    };
    const response = await this.fetchImpl(joinedUrl(signBaseUrl, MODERATION_JSON_SIGN_PATH), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(signRequest),
      signal,
    });
    return this.parseSignedJson(response, await jsonResponse(response));
  }

  private parseSignedJson(
    response: Response,
    value: Record<string, unknown> | null,
  ): ModerationSignedJsonResponse | null {
    if (response.status !== 200) return null;
    const parsed = parseModerationSignedJsonResponse(value, MODERATION_SUBMIT_LOGICAL_PATH);
    return parsed.ok ? parsed.value : null;
  }

  private parseSignedUpload(
    response: Response,
    value: Record<string, unknown> | null,
  ): ModerationSignedUploadResponse | null {
    if (response.status !== 200) return null;
    const parsed = parseModerationSignedUploadResponse(value);
    return parsed.ok ? parsed.value : null;
  }
}
