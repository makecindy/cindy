import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import sharp from 'sharp';
import type { CindyEvaluateToolRequest } from 'cindy-tools';
import { refreshXdGatewayModels } from '../model-access/index.js';
import { getAuthState } from '../authManager.js';
import { resolveGatewayConnection, GatewayConnectionError } from '../model-access/gatewayConnection.js';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { desktopAnthropicImageCodec } from '../maker-host/anthropic-image-codec.js';
import { getGatewayModelPricing, getModelPriceQuote } from '../usage/modelPricing.js';
import { computeGatewayTurnCost } from '../usage/turnCostCalculator.js';
import { parseGatewayMediaBillingHeader } from '../usage/gatewayMediaBillingHeader.js';
import { prepareGatewayMediaBilling } from '../usage/gatewayMediaBilling.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export { EvaluationError } from './errors.js';
import { EvaluationError } from './errors.js';
export function evaluationFailure(errorCode: string, message: string, retryable = false, outcomeKnown = true) {
  return { ok: false, errorCode, message, retryable, outcomeKnown };
}
import { listEvaluationModels } from './models.js';
import { EVALUATION_GUIDE } from './guide.js';
export { listEvaluationModels } from './models.js';
export interface EvaluationContext {
  sessionId?: string;
  signal?: AbortSignal;
  /** Resolves and authorizes the reference in the caller's own file/installation scope. */
  readImage(ref: string): Promise<Buffer>;
  assertCurrent(): void;
}
export async function readEvaluationImageFile(path: string): Promise<Buffer> {
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new EvaluationError('INVALID_INPUT', '图片文件过大或不是普通文件');
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const bound = await fs.stat(path);
    if (offset !== stat.size || bound.dev !== stat.dev || bound.ino !== stat.ino) throw new EvaluationError('INVALID_INPUT', '图片文件在读取期间发生变化');
    return data.subarray(0, offset);
  } finally { await file.close(); }
}
async function prepareState(state: unknown, context: EvaluationContext, model: string): Promise<unknown> {
  if (!Array.isArray(state)) return state;
  const requiresMinEdge = model.startsWith('typesafe/');
  let count = 0;
  let total = 0;
  const result: unknown[] = [];
  for (const item of state) {
    if (!item || typeof item !== 'object' || item.type !== 'image_url') { result.push(item); continue; }
    if (++count > 16 || typeof item.image_url?.url !== 'string') throw new EvaluationError('INVALID_INPUT', '单次最多 16 张图片，图片必须提供地址');
    context.assertCurrent();
    const bytes = await context.readImage(item.image_url.url);
    total += bytes.length;
    if (total > MAX_BYTES) throw new EvaluationError('INVALID_INPUT', '图片总大小超过 32 MiB');
    const metadata = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
    if (!metadata.width || !metadata.height) throw new EvaluationError('INVALID_INPUT', '图片尺寸无效');
    if (requiresMinEdge && Math.min(metadata.width, metadata.height) < 256) {
      throw new EvaluationError('INVALID_INPUT', '此模型要求图片的每边至少为 256 像素');
    }
    const image = await desktopAnthropicImageCodec.normalize({ data: bytes.toString('base64'), mediaType: '',
      maxEdge: 1568, qualities: [85, 70, 55, 40], hardCap: 8 * 1024 * 1024,
      allowedMediaTypes: ['image/png', 'image/jpeg'] });
    if (!image) throw new EvaluationError('INVALID_INPUT', '图片无法解码');
    const normalized = await sharp(Buffer.from(image.data, 'base64')).metadata();
    if (requiresMinEdge && Math.min(normalized.width ?? 0, normalized.height ?? 0) < 256) throw new EvaluationError('INVALID_INPUT', '图片缩放后短边不足 256 像素，请裁剪后重试');
    result.push({ ...item, image_url: { ...item.image_url, url: `data:${image.mediaType};base64,${image.data}` } });
  }
  return result;
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(next.value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { if (!response.ok) return { error: { message: text.slice(0, 1000) } }; throw new Error('Invalid response'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
    return value as Record<string, unknown>;
  } finally { reader.releaseLock(); }
}
export async function callEvaluate(request: CindyEvaluateToolRequest, context: EvaluationContext): Promise<Record<string, unknown>> {
  let submitted = false;
  let finishBilling: (() => void) | undefined;
  const generation = getAuthState().ownerGeneration;
  const assertCurrent = () => {
    context.signal?.throwIfAborted();
    context.assertCurrent();
    if (getAuthState().ownerGeneration !== generation) throw new EvaluationError('ACCOUNT_CHANGED', '调用期间账号发生变化');
  };
  try {
    assertCurrent();
    const api = request.action === 'list_models' ? request.api : request.action;
    if (api !== 'decisions' && api !== 'rerank') throw new EvaluationError('INVALID_INPUT', 'api 必须是 decisions 或 rerank');
    const models = listEvaluationModels(api);
    if (request.action === 'list_models') return { ok: true, models, guide: EVALUATION_GUIDE[api] };
    if (request.provider_id && request.provider_id !== 'xd') throw new EvaluationError('MODEL_NOT_FOUND', '该来源不支持决策或重排');
    const model = request.model_id ?? (models.length === 1 ? models[0].id : undefined);
    if (!model) throw new EvaluationError('MODEL_REQUIRED', '请从 list_models 返回的模型中指定 model_id');
    if (!models.some(item => item.id === model)) throw new EvaluationError('MODEL_NOT_AUTHORIZED', '模型不可用或已停用');
    let body: Record<string, unknown>;
    if (api === 'decisions') {
      if (!request.questions || typeof request.questions !== 'object' || Array.isArray(request.questions) || !Object.keys(request.questions).length || (request.state === null || (typeof request.state !== 'string' && typeof request.state !== 'object'))) throw new EvaluationError('INVALID_INPUT', 'decisions 必须提供 questions 和 state');
      for (const question of Object.values(request.questions)) {
        if (!question || typeof question !== 'object' || !('type' in question) || !['noul', 'choice', 'score', 'box'].includes(String(question.type)) || !('instructions' in question) || typeof question.instructions !== 'string') throw new EvaluationError('INVALID_INPUT', '问题必须提供合法 type 和 instructions');
      }
      body = { model, questions: request.questions, state: await prepareState(request.state, { ...context, assertCurrent }, model) };
    } else {
      if (typeof request.query !== 'string' || !Array.isArray(request.documents) || !request.documents.length || request.documents.some(item => typeof item !== 'string') || (request.top_n !== undefined && (!Number.isInteger(request.top_n) || request.top_n < 1 || request.top_n > request.documents.length))) throw new EvaluationError('INVALID_INPUT', 'rerank 必须提供 query、非空 documents 和合法的 top_n');
      body = { model, query: request.query, documents: request.documents, ...(request.top_n !== undefined ? { top_n: request.top_n } : {}) };
    }
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new EvaluationError('INVALID_INPUT', '请求体超过 32 MiB');
    let connection = resolveGatewayConnection('xd');
    const quote = getModelPriceQuote(await getGatewayModelPricing(), 'xd', model);
    let estimate: { amount: number; currency: 'USD' | 'CNY' } | null = null;
    const recordBilling = await prepareGatewayMediaBilling({ model, sessionId: context.sessionId,
      estimatedBilling: () => estimate });
    finishBilling = recordBilling.finish;
    assertCurrent();
    const currentConnection = resolveGatewayConnection('xd');
    if (currentConnection.baseUrl !== connection.baseUrl || currentConnection.apiKey !== connection.apiKey) throw new EvaluationError('ACCOUNT_CHANGED', '模型连接发生变化');
    if (!listEvaluationModels(api).some(item => item.id === model)) throw new EvaluationError('MODEL_NOT_AUTHORIZED', '模型已停用');
    const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(context.signal ? [context.signal] : [])]);
    submitted = true;
    const dispatch = () => outboundFetch(new URL(api === 'decisions' ? '/api/alpha/decisions' : '/v1/rerank', connection.baseUrl).toString(), {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' }, body: encoded,
    });
    let response = await dispatch();
    if (response.status === 401) {
      connection.onUnauthorized();
      const rejected = await responseJson(response).catch(() => ({} as Record<string, unknown>));
      const rejectedError = rejected.error as { message?: unknown } | undefined;
      const rejectedMessage = String(rejectedError?.message ?? 'HTTP 401').split(connection.apiKey).join('[redacted]').slice(0, 1000);
      await refreshXdGatewayModels();
      assertCurrent();
      signal.throwIfAborted();
      const refreshed = resolveGatewayConnection('xd');
      if (refreshed.apiKey === connection.apiKey) return evaluationFailure('CONNECTION_UNAVAILABLE', `Cindy AI 凭证已被拒绝，请重新连接：${rejectedMessage}`);
      if (!listEvaluationModels(api).some(item => item.id === model)) return evaluationFailure('MODEL_NOT_AUTHORIZED', '模型不可用或已停用');
      connection = refreshed;
      response = await dispatch();
      if (response.status === 401) connection.onUnauthorized();
    }
    // A confirmed header charge survives an unreadable response body. Token estimates
    // can only be settled later, once usage has arrived.
    const actualBilling = parseGatewayMediaBillingHeader(response.headers.get('X-Nova-AIGateway-Billing'))
      ? recordBilling(response) : undefined;
    let data: Record<string, unknown>;
    try {
      data = await responseJson(response).catch((error): Record<string, unknown> => {
        if (!response.ok) return {};
        throw error;
      });
    } finally { await actualBilling; }
    if (!response.ok) {
      const error = data.error as { message?: unknown } | undefined;
      const detail = String(error?.message ?? `HTTP ${response.status}`).split(connection.apiKey).join('[redacted]').slice(0, 1000);
      const code = response.status === 400 ? 'INVALID_INPUT' : response.status === 403 ? 'MODEL_NOT_AUTHORIZED' : response.status === 404 ? 'MODEL_NOT_FOUND' : response.status === 401 ? 'CONNECTION_UNAVAILABLE' : 'UPSTREAM_UNAVAILABLE';
      if (response.status >= 500) return evaluationFailure(code, `${detail}；请求可能已执行，请勿自动重提`, false, false);
      return evaluationFailure(code, detail, response.status === 429);
    }
    const usage = data.usage as Record<string, unknown> | undefined;
    const inputTokens = api === 'rerank' ? usage?.total_tokens : usage?.input_tokens;
    const outputTokens = api === 'rerank' ? 0 : usage?.output_tokens;
    if (typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0 && typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
      const amount = computeGatewayTurnCost({ inputTokens, outputTokens, cacheReadTokens: 0, cacheCreateTokens: 0 }, quote);
      if (amount !== null && Number.isFinite(amount) && quote) estimate = { amount: amount * (1 - (quote.costDiscount ?? 0)), currency: quote.currency };
    }
    if (!actualBilling) await recordBilling(response);
    assertCurrent();
    if (api === 'decisions' && !Object.hasOwn(data, 'answers')) throw new Error('Invalid decisions response');
    if (api === 'decisions') return { ok: true, model: data.model ?? model, answers: data.answers, usage: data.usage, estimated_cost: estimate };
    if (!Array.isArray(data.results)) throw new Error('Invalid rerank response');
    const results = data.results.map(item => {
      if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= request.documents!.length || typeof item.relevance_score !== 'number' || !Number.isFinite(item.relevance_score)) throw new Error('Invalid rerank result');
      return { index: item.index, relevance_score: item.relevance_score };
    });
    return { ok: true, model: data.model ?? model, results, usage: data.usage, estimated_cost: estimate };
  } catch (error) {
    if (error instanceof EvaluationError || error instanceof GatewayConnectionError) return evaluationFailure(
      error.code, submitted ? `${error.message}；请求可能已经执行，请勿自动重提` : error.message, false, !submitted,
    );
    return submitted ? evaluationFailure('SUBMISSION_OUTCOME_UNKNOWN', '请求结果无法确认，请勿自动重提', false, false)
      : evaluationFailure('INVALID_INPUT', '调用未发出，请检查参数、图片和连接状态');
  } finally { finishBilling?.(); }
}
