/** 订阅视频的持久提交/轮询桥接；未知提交不重发，成品交付失败保留原单。 */
import type { DbClient } from '../localDb/client/DbClient.js';
import { VideoProviderHttpError } from '../cindy-proxy-media/video/types.js';
import { resolveProviderMediaModel, resolveProviderVideo } from './providerMediaRuntime.js';
import { MediaDownloadError } from './mediaDownload.js';
import {
  transitionMediaInvocation,
  getMediaInvocation,
  type StoredMediaInvocation,
} from './mediaInvocationStore.js';
import {
  assertVideoScope,
  decodeVideoHandle,
  encodeVideoHandle,
  providerVideoRequest,
  ProviderVideoError,
  videoResponse,
} from './providerVideoGuide.js';

type Result = Record<string, unknown>;
export interface ProviderVideoContext {
  db: DbClient;
  signal?: AbortSignal;
  assertActive(): void;
  resolveImage(ref: string): Promise<string>;
  materialize(
    url: string,
    allowedHosts: string[],
    assertProvider: () => void,
    networkPolicy?: 'xai-video',
  ): Promise<Result>;
  complete(invocation: StoredMediaInvocation, media: Result): Promise<Result>;
  completed(invocation: StoredMediaInvocation): Result;
}

function fail(
  code: string,
  message: string,
  invocation: StoredMediaInvocation,
  retryable = false,
): Result {
  return { ok: false, errorCode: code, message, retryable, invocation_id: invocation.id };
}
function unknown(invocation: StoredMediaInvocation): Result {
  return {
    ...fail(
      'SUBMISSION_OUTCOME_UNKNOWN',
      '无法确认视频提交结果，请检查原调用，不要重新提交生成',
      invocation,
    ),
    outcomeKnown: false,
    allowedActions: ['wait_or_check_existing_task', 'ask_user_before_new_submission'],
  };
}

function deliveryFailure(invocation: StoredMediaInvocation, error: unknown): Result {
  const known = error instanceof MediaDownloadError;
  const code = known ? error.code : 'MEDIA_MATERIALIZATION_FAILED';
  return {
    ...fail(
      code,
      '视频已生成，但交付未完成；保留原调用，不重新生成',
      invocation,
      known ? error.retryable : true,
    ),
    result_retained: true,
    allowedActions: ['poll_same_invocation'],
    ...(known && error.diagnostic
      ? { delivery_error: error.diagnostic }
      : { delivery_error: { stage: 'ingest' } }),
  };
}
function signal(ctx: ProviderVideoContext, timeoutMs: number): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
}
function binding(invocation: StoredMediaInvocation, ctx: ProviderVideoContext) {
  const provider = resolveProviderVideo(invocation.guide.connection.providerId, invocation.modelId);
  if (!provider)
    throw new ProviderVideoError('MODEL_NOT_AVAILABLE', '原视频执行来源不可用，请勿重新提交生成');
  assertVideoScope(provider, invocation.guide);
  const captured = provider.captureScope!();
  const assertCurrent = () => {
    ctx.assertActive();
    assertVideoScope(provider, invocation.guide);
    const current = provider.captureScope!();
    if (
      current.ownerScopeKey !== captured.ownerScopeKey ||
      current.credentialGeneration !== captured.credentialGeneration
    ) {
      throw new ProviderVideoError('ACCOUNT_CHANGED', '视频请求期间账号或授权已变化');
    }
  };
  assertCurrent();
  return { provider, assertCurrent };
}
async function transition(
  invocation: StoredMediaInvocation,
  ctx: ProviderVideoContext,
  from: StoredMediaInvocation['state'],
  to: StoredMediaInvocation['state'],
  data: { taskId?: string; responseJson?: string } = {},
) {
  ctx.assertActive();
  const changed = await transitionMediaInvocation(
    { id: invocation.id, owner: invocation.owner, from, to, ...data },
    ctx.db,
  );
  ctx.assertActive();
  return changed;
}
function pending(invocation: StoredMediaInvocation): Result {
  const handle = decodeVideoHandle(invocation.taskId, invocation.guide);
  return {
    ok: true,
    status: 'pending',
    invocation_id: invocation.id,
    task_id: handle.taskId,
    provider_id: invocation.guide.connection.providerId,
    model_id: invocation.modelId,
    recommended_poll_after_ms: videoResponse(invocation.guide).recommendedIntervalMs,
  };
}

export async function submitProviderVideo(
  invocation: StoredMediaInvocation,
  body: Result,
  ctx: ProviderVideoContext,
): Promise<Result> {
  const providerId = invocation.guide.connection.providerId;
  if (!resolveProviderMediaModel(providerId, invocation.modelId, invocation.capability)) {
    return {
      ...fail('MODEL_NOT_AVAILABLE', '视频来源已停用或不可用，本次生成未发出', invocation),
      outcomeKnown: true,
    };
  }
  const { provider, assertCurrent } = binding(invocation, ctx);
  const input = await providerVideoRequest(body, invocation.guide, provider, ctx.resolveImage);
  assertCurrent();
  const claimed = await transition(invocation, ctx, 'prepared', 'submitting');
  if (!claimed) {
    const latest = await getMediaInvocation(invocation.id, invocation.owner, ctx.db);
    ctx.assertActive();
    return latest?.state === 'pending'
      ? pending(latest)
      : fail('INVOCATION_ALREADY_USED', '该调用已提交，不能重复生成', invocation);
  }
  let dispatched = false;
  try {
    // prepared 到 submitting 期间可发生账号切换或停用；发起请求前再次复核。
    assertCurrent();
    if (!resolveProviderMediaModel(providerId, invocation.modelId, invocation.capability)) {
      await transition(invocation, ctx, 'submitting', 'failed');
      return {
        ...fail('MODEL_NOT_AVAILABLE', '视频来源已停用，本次生成未发出', invocation),
        outcomeKnown: true,
      };
    }
    dispatched = true;
    const handle = await provider.submit(
      input,
      invocation.modelId,
      signal(ctx, invocation.guide.request.timeoutMs),
    );
    assertCurrent();
    const scope = videoResponse(invocation.guide).scope;
    const taskId = encodeVideoHandle(
      {
        ...handle,
        ownerScopeKey: scope.ownerScopeKey,
        credentialGeneration: scope.credentialGeneration,
      },
      invocation.guide,
    );
    if (!(await transition(invocation, ctx, 'submitting', 'pending', { taskId }))) {
      await transition(invocation, ctx, 'submitting', 'unknown');
      return unknown(invocation);
    }
    return pending({ ...invocation, state: 'pending', taskId });
  } catch (error) {
    ctx.assertActive();
    const rejected =
      !dispatched ||
      (error instanceof VideoProviderHttpError && error.status >= 400 && error.status < 500);
    await transition(invocation, ctx, 'submitting', rejected ? 'failed' : 'unknown').catch(
      () => false,
    );
    if (!rejected) return unknown(invocation);
    return {
      ...fail(
        error instanceof ProviderVideoError ? error.code : 'UPSTREAM_REJECTED',
        error instanceof ProviderVideoError ? error.message : '视频来源拒绝本次提交，未创建新视频',
        invocation,
      ),
      outcomeKnown: true,
    };
  }
}

async function deliver(
  invocation: StoredMediaInvocation,
  response: unknown,
  ctx: ProviderVideoContext,
): Promise<Result> {
  const { provider, assertCurrent } = binding(invocation, ctx);
  const result = response as { videoUrl?: unknown } | null;
  if (!result || typeof result.videoUrl !== 'string' || !provider.resolveDownload) {
    throw new ProviderVideoError('MEDIA_RESULT_INVALID', '已完成视频缺少合法下载引用');
  }
  let source;
  try {
    source = provider.resolveDownload(
      result.videoUrl,
      videoResponse(invocation.guide).scope.credentialSessionId,
    );
  } catch {
    assertCurrent();
    throw new MediaDownloadError(
      'MEDIA_RESULT_INVALID',
      '原视频下载引用未通过校验，已保留成功记录',
      { stage: 'validation' },
      false,
    );
  }
  const assertProvider = () => {
    assertCurrent();
    source.assertActive();
  };
  assertProvider();
  const media = await ctx.materialize(
    source.url,
    source.allowedUrlHosts,
    assertProvider,
    source.networkPolicy,
  );
  assertProvider();
  const completed = await ctx.complete(invocation, media);
  assertProvider();
  return completed;
}

export async function pollProviderVideo(
  invocation: StoredMediaInvocation,
  ctx: ProviderVideoContext,
): Promise<Result> {
  if (invocation.state === 'complete') return ctx.completed(invocation);
  if (invocation.state === 'unknown') return unknown(invocation);
  if (invocation.state !== 'pending')
    return fail('INVOCATION_NOT_PENDING', '该视频调用不处于待查询状态', invocation);
  const { provider, assertCurrent } = binding(invocation, ctx);
  const handle = decodeVideoHandle(invocation.taskId, invocation.guide);
  await transition(invocation, ctx, 'pending', 'pending');
  let refreshResult = false;
  if (invocation.responseJson) {
    try {
      return await deliver(invocation, JSON.parse(invocation.responseJson), ctx);
    } catch (error) {
      assertCurrent();
      if ((error as { code?: string }).code !== 'MEDIA_DOWNLOAD_URL_EXPIRED') {
        return deliveryFailure(invocation, error);
      }
      // 临时地址失效只能查询同一上游任务，直到新成品入库才覆盖旧成功响应。
      refreshResult = true;
    }
  }
  let status;
  try {
    assertCurrent();
    const restored = provider.restoreHandle!(
      handle,
      videoResponse(invocation.guide).scope.credentialSessionId,
    );
    status = await provider.poll(restored, signal(ctx, 30_000));
    assertCurrent();
  } catch (error) {
    assertCurrent();
    if (
      error instanceof VideoProviderHttpError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    ) {
      // A rejected GET is not proof the generation failed. Retain the handle,
      // but do not suggest automatic retries of a non-transient rejection.
      return fail(
        'UPSTREAM_POLL_REJECTED',
        '视频来源拒绝查询，请保留原调用并检查来源状态，不重新生成',
        invocation,
      );
    }
    return fail(
      'POLL_UNAVAILABLE',
      '视频查询暂时不可用，请继续查询原调用，不重新生成',
      invocation,
      true,
    );
  }
  if (status.state === 'failed') {
    // 已保存成功响应时，上游任务过期不抹掉可恢复的成品记录。
    if (invocation.responseJson) {
      return {
        ...fail(
          'UPSTREAM_RESULT_UNAVAILABLE',
          '原任务暂无法再提供下载地址；已保留成功记录，不重新生成',
          invocation,
        ),
        result_retained: true,
        delivery_error: { stage: 'refresh' },
        allowedActions: ['review_existing_task_no_resubmit'],
      };
    }
    await transition(invocation, ctx, 'pending', 'failed');
    return fail('UPSTREAM_TASK_FAILED', '上游视频任务已失败或过期', invocation);
  }
  if (status.state === 'pending' || status.state === 'running') return pending(invocation);
  const responseJson = JSON.stringify({ videoUrl: status.videoUrl, meta: status.meta });
  if (
    !refreshResult &&
    !(await transition(invocation, ctx, 'pending', 'pending', { responseJson }))
  ) {
    return fail('MEDIA_MATERIALIZATION_FAILED', '视频结果尚未保存；请保留原调用', invocation);
  }
  try {
    return await deliver({ ...invocation, responseJson }, JSON.parse(responseJson), ctx);
  } catch (error) {
    assertCurrent();
    const failure = deliveryFailure(invocation, error);
    if (refreshResult && error instanceof MediaDownloadError && error.code === 'MEDIA_DOWNLOAD_URL_EXPIRED') {
      // 刷新原单后仍被拒绝不能无限建议自动重试，也不能把 403/404 武断定为过期。
      return { ...failure, retryable: false, url_refresh_attempted: true,
        message: '原任务地址刷新后仍无法交付；已保留成功记录，请检查下载诊断，不重新生成' };
    }
    return failure;
  }
}
