/**
 * skillhub/publishService.ts — publish 端到端编排 (F-pub-5, M5)
 *
 * 架构约束：
 *   - 编排全部在 main 进程（决策1）
 *   - renderer 仅订阅 skillhub:publish-progress 切状态机
 *   - zip buffer 仅 main 持有（不跨进程传递）
 *   - OSS PUT 失败时缓存 packCache+initCache，重试不重打包
 *   - Hub 远端扫描由 main 持久化 pending state 后后台收尾，避免 renderer
 *     关闭/重启导致本地 snapshot/registry 悬空。
 */

import fs from 'node:fs';
import path from 'node:path';
import { net } from 'electron';
import { ServerApiError } from '../serverApiClient';
import { skillhubApiFetch } from './hubApi';
import { computeFolderHash } from './folderHash';
import { writeSnapshot } from './snapshot';
import { pack } from './zipPacker';
import type { PackResult } from './zipPacker';
import { registryService } from './registry';
import type { SkillhubCatalogScope } from '../../shared/skillhubCatalog';
import { getCurrentDataOwnerId, getCurrentUserId } from '../authManager';
import { getAppCapabilities } from '../appCapabilities.js';
import { currentSkillhubIdentityPolicy } from './identityPolicy';

import { createLogger } from '../logger';

const log = createLogger('skillhub:publishService');
export const PACK_TIMEOUT_MS = 45_000;

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface PublishParams {
  absolutePath: string;
  name: string;
  isFirstPublish: boolean;
  version?: string;
  displayName?: string;
  summary?: string;
  description?: string;
  visibility?: 'PUBLIC' | 'DEPARTMENT_SCOPED' | 'PRIVATE';
  visibleSlugs?: string[];
  /** 发布者为部门时的部门归属(od- 开头,Hub 端自动转部门团队) */
  deptTeamSlug?: string;
  /** 发布者为普通团队时的团队归属 slug */
  teamSlug?: string;
  tags?: string[];
  changelog?: string;
}

export type PublishErrorCode =
  | 'NAME_TAKEN'
  | 'INVALID_DEPT'
  | 'INVALID_NAME'
  | 'VERSION_RACE'
  | 'CHECKSUM_MISMATCH'
  | 'NOT_AUTHOR'
  | 'PACK_FAILED'
  | 'OSS_PUT_FAILED'
  | 'OSS_PUT_EXPIRED'
  | 'OSS_OBJECT_NOT_FOUND'
  | 'API_KEY_MISSING'
  | 'CATEGORY_REQUIRED'
  | 'MANIFEST_INVALID'
  | 'CANCELLED'
  | 'SKILL_HUB_READ_ONLY'
  | 'INVALID_VISIBILITY'
  | 'INTERNAL';

export type PublishProgressEvent =
  | { phase: 'packing' }
  | { phase: 'init' }
  | { phase: 'uploading' }
  | { phase: 'commit' }
  | { phase: 'done'; name: string; version: string }
  | { phase: 'scan-status'; name: string; version: string; status: string; gates?: ScanGate[] }
  | { phase: 'scan-result'; name: string; version: string; status: string; gates?: ScanGate[] }
  | { phase: 'failed'; name?: string; errorCode: PublishErrorCode; message: string };

type ProgressCb = (e: PublishProgressEvent) => void;

interface InternalState {
  abortController: AbortController;
  /** 失败重试不重打包 */
  packCache?: PackResult;
  /** 失败重试不重走 init（除非 OSS_PUT_EXPIRED） */
  initCache?: { nextVersion: string; ossKey: string; uploadUrl: string };
}

export interface ScanGate {
  name: string;
  label?: Record<string, string>;
  status: string;
  issues?: unknown[];
}

interface ScanStatusResponse {
  status: string;
  gates?: ScanGate[];
  scorecard?: unknown;
}

export interface SkillPublishServiceOptions {
  onProgress?: ProgressCb;
  scanPollIntervalMs?: number;
  /** Local zip creation should be quick for normal skill folders; configurable for focused tests. */
  packTimeoutMs?: number;
}

interface InitResponse {
  nextVersion: string;
  ossKey: string;
  uploadUrl: string;
}

// ── gray-matter SKILL.md 解析 ─────────────────────────────────────────────────

async function updateSkillMdVersion(absolutePath: string, version: string): Promise<void> {
  const skillMdPath = path.join(absolutePath, 'SKILL.md');
  const content = await fs.promises.readFile(skillMdPath, 'utf-8');
  const grayMatter = await import('gray-matter');
  const parsed = grayMatter.default(content);
  if (parsed.data.version === version) return;
  parsed.data.version = version;
  const updated = grayMatter.default.stringify(parsed.content, parsed.data);
  await fs.promises.writeFile(skillMdPath, updated, 'utf-8');
}

// ── errorCode 映射 ────────────────────────────────────────────────────────────

function serverErrorToCode(err: unknown): PublishErrorCode {
  if (err instanceof ServerApiError) {
    const code = err.code;
    if (code === 'NAME_TAKEN') return 'NAME_TAKEN';
    if (code === 'INVALID_DEPT') return 'INVALID_DEPT';
    if (code === 'INVALID_NAME') return 'INVALID_NAME';
    if (code === 'VERSION_RACE') return 'VERSION_RACE';
    if (code === 'CHECKSUM_MISMATCH') return 'CHECKSUM_MISMATCH';
    if (code === 'NOT_AUTHOR') return 'NOT_AUTHOR';
    if (code === 'INVALID_VISIBILITY') return 'INVALID_VISIBILITY';
    if (code === 'OSS_OBJECT_NOT_FOUND') return 'OSS_OBJECT_NOT_FOUND';
    if (err.message.includes('manifest') || err.message.includes('frontmatter'))
      return 'MANIFEST_INVALID';
    return 'INTERNAL';
  }
  return 'INTERNAL';
}

function unhandledPublishErrorToCode(err: unknown): PublishErrorCode {
  if (err instanceof ServerApiError) return serverErrorToCode(err);
  return 'INTERNAL';
}

function normalizePublishTags(tags?: string[]): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
}

const PASSING_SCAN_STATUSES = new Set(['pass', 'passed', 'approved', 'published']);
const FAILING_SCAN_STATUSES = new Set(['fail', 'failed', 'quarantine', 'rejected', 'blocked']);

function normalizeScanStatus(status: string): string {
  return status.trim().toLowerCase();
}

function isTerminalScanStatus(status: string): boolean {
  const normalized = normalizeScanStatus(status);
  return PASSING_SCAN_STATUSES.has(normalized) || FAILING_SCAN_STATUSES.has(normalized);
}

function isPendingManualReviewStatus(status: string): boolean {
  return normalizeScanStatus(status) === 'pending';
}

async function syncPublishedRegistry(
  slug: string,
  absolutePath: string,
  version: string,
  folderHash: string,
  catalogScope?: SkillhubCatalogScope | null,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const myUserId = getCurrentUserId() ?? '';
  const existing = await registryService.getInstall(slug, absolutePath);
  if (existing) {
    await registryService.updateInstall(slug, absolutePath, {
      version,
      folderHash,
      updatedAt: nowSec,
      authorId: myUserId,
      origin: 'published',
      ...(catalogScope !== undefined ? { catalogScope: catalogScope ?? undefined } : {}),
    });
  } else {
    await registryService.addInstall(slug, absolutePath, {
      version,
      authorId: myUserId,
      folderHash,
      installedAt: nowSec,
      updatedAt: nowSec,
      origin: 'published',
      ...(catalogScope ? { catalogScope } : {}),
    });
  }
}

// ── SkillPublishService ───────────────────────────────────────────────────────

export class SkillPublishService {
  private current: InternalState | null = null;
  private readonly onProgress?: ProgressCb;
  private readonly scanPollIntervalMs: number;
  private readonly packTimeoutMs: number;
  private activeScanPoll: {
    slug: string;
    version: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private scanPollGeneration = 0;

  constructor(options: SkillPublishServiceOptions = {}) {
    this.onProgress = options.onProgress;
    this.scanPollIntervalMs = options.scanPollIntervalMs ?? 5_000;
    this.packTimeoutMs = options.packTimeoutMs ?? PACK_TIMEOUT_MS;
  }

  /** 取消当前 publish（renderer 调 skillhub:cancel-publish 时触发） */
  cancel(): void {
    this.current?.abortController.abort();
  }

  async publish(
    params: PublishParams,
    onProgress: ProgressCb = () => {},
  ): Promise<{
    success: boolean;
    result?: { name: string; version: string };
    errorCode?: string;
    error?: string;
  }> {
    if (!getAppCapabilities().canUseSkillHubCloud) {
      this.emitProgress(
        {
          phase: 'failed',
          name: params.name,
          errorCode: 'CANCELLED',
          message: 'SkillHub publish is unavailable in local mode',
        },
        onProgress,
      );
      return { success: false, errorCode: 'CANCELLED' };
    }
    const identityPolicy = await currentSkillhubIdentityPolicy();
    if (!identityPolicy.canWrite) {
      this.emitProgress(
        {
          phase: 'failed',
          name: params.name,
          errorCode: 'CANCELLED',
          message: 'SkillHub publish requires sign-in',
        },
        onProgress,
      );
      return { success: false, errorCode: 'CANCELLED' };
    }
    if (
      params.isFirstPublish
      && params.visibility
      && !identityPolicy.allowedVisibilities.includes(params.visibility)
    ) {
      this.emitProgress(
        {
          phase: 'failed',
          name: params.name,
          errorCode: 'INVALID_VISIBILITY',
          message: identityPolicy.ownerType === 'organization'
            ? 'Organization skills only support public or organization visibility'
            : 'Personal skills only support public or private visibility',
        },
        onProgress,
      );
      return { success: false, errorCode: 'INVALID_VISIBILITY' };
    }
    const publishOwnerId = getCurrentDataOwnerId();
    if (!publishOwnerId) {
      this.emitProgress(
        {
          phase: 'failed',
          name: params.name,
          errorCode: 'CANCELLED',
          message: 'SkillHub publish requires an active data owner',
        },
        onProgress,
      );
      return { success: false, errorCode: 'CANCELLED' };
    }
    const tags = params.isFirstPublish ? normalizePublishTags(params.tags) : undefined;
    if (this.current) {
      this.emitProgress(
        {
          phase: 'failed',
          name: params.name,
          errorCode: 'INTERNAL',
          message: '已有发布任务进行中',
        },
        onProgress,
      );
      return { success: false, errorCode: 'INTERNAL' };
    }

    const abortController = new AbortController();
    const state: InternalState = { abortController };
    this.current = state;

    const signal = abortController.signal;
    const isCancelled = (): boolean =>
      signal.aborted ||
      !getAppCapabilities().canUseSkillHubCloud ||
      getCurrentDataOwnerId() !== publishOwnerId;

    let originalSkillMd: string | null = null;
    let publishSucceeded = false;
    try {
      // ── 步骤 0: 把版本号写入 SKILL.md ──────────────────────────────────────
      if (params.version) {
        const skillMdPath = path.join(params.absolutePath, 'SKILL.md');
        try {
          originalSkillMd = await fs.promises.readFile(skillMdPath, 'utf-8');
        } catch {
          /* 文件不存在则无需回滚 */
        }
        await updateSkillMdVersion(params.absolutePath, params.version);
      }

      // ── 步骤 1: folderHash（registry sync 需要） ───────────────────────────
      const folderHash = await computeFolderHash(params.absolutePath);

      // ── 步骤 2: 打包 ─────────────────────────────────────────────────────
      if (!state.packCache) {
        this.emitProgress({ phase: 'packing' }, onProgress);
        if (isCancelled()) {
          this.emitProgress(
            { phase: 'failed', name: params.name, errorCode: 'CANCELLED', message: '已取消' },
            onProgress,
          );
          return { success: false, errorCode: 'CANCELLED' };
        }
        try {
          state.packCache = await pack(params.absolutePath, {
            timeoutMs: this.packTimeoutMs,
            signal,
          });
        } catch (err) {
          if (isCancelled()) throw err;
          const message = err instanceof Error ? err.message : String(err);
          log.error(`[publish:pack] failed | name=${params.name}:`, err);
          this.emitProgress(
            {
              phase: 'failed',
              name: params.name,
              errorCode: 'PACK_FAILED',
              message,
            },
            onProgress,
          );
          return { success: false, errorCode: 'PACK_FAILED', error: message };
        }
      }

      if (isCancelled()) {
        this.emitProgress(
          { phase: 'failed', name: params.name, errorCode: 'CANCELLED', message: '已取消' },
          onProgress,
        );
        return { success: false, errorCode: 'CANCELLED' };
      }

      // ── 步骤 4: publish/init ─────────────────────────────────────────────
      let versionRaceRetries = 0;

      for (;;) {
        if (!state.initCache) {
          this.emitProgress({ phase: 'init' }, onProgress);
          if (isCancelled()) {
            this.emitProgress(
              { phase: 'failed', name: params.name, errorCode: 'CANCELLED', message: '已取消' },
              onProgress,
            );
            return { success: false, errorCode: 'CANCELLED' };
          }

          try {
            const initResp = await skillhubApiFetch<InitResponse>(
              '/api/skills-hub/skills/publish/init',
              {
                method: 'POST',
                body: { slug: params.name, ...(params.version && { version: params.version }) },
              },
            );
            state.initCache = initResp;
            const urlPreview = (() => {
              try {
                const u = new URL(initResp.uploadUrl);
                const queryKeys = Array.from(u.searchParams.keys());
                const hasSignature = queryKeys.includes('Signature');
                const expiresRaw = u.searchParams.get('Expires');
                const expiresAt = expiresRaw
                  ? new Date(Number(expiresRaw) * 1000).toISOString()
                  : 'none';
                return `${u.origin}${u.pathname} | queryKeys=[${queryKeys.join(',')}] hasSignature=${hasSignature} expiresAt=${expiresAt}`;
              } catch {
                return '<invalid>';
              }
            })();
            log.debug(
              `[publish:init] ok | name=${params.name} ossKey=${initResp.ossKey} uploadUrl=${urlPreview}`,
            );
          } catch (err) {
            log.error(`[publish:init] failed | name=${params.name} err=`, err);
            if (isCancelled()) {
              this.emitProgress(
                { phase: 'failed', name: params.name, errorCode: 'CANCELLED', message: '已取消' },
                onProgress,
              );
              return { success: false, errorCode: 'CANCELLED' };
            }
            const code = serverErrorToCode(err);
            this.emitProgress(
              {
                phase: 'failed',
                name: params.name,
                errorCode: code,
                message: err instanceof Error ? err.message : String(err),
              },
              onProgress,
            );
            return { success: false, errorCode: code };
          }
        }

        // ── 步骤 5: OSS PUT ──────────────────────────────────────────────
        this.emitProgress({ phase: 'uploading' }, onProgress);
        if (isCancelled()) {
          this.emitProgress(
            { phase: 'failed', name: params.name, errorCode: 'CANCELLED', message: '已取消' },
            onProgress,
          );
          return { success: false, errorCode: 'CANCELLED' };
        }

        let ossOk = false;
        let ossExpired = false;
        let ossFailDetail = '';

        const urlForLog = (() => {
          try {
            const u = new URL(state.initCache.uploadUrl);
            return `${u.origin}${u.pathname}`;
          } catch {
            return '<invalid url>';
          }
        })();
        log.debug(
          `[publish:oss] PUT start | url=${urlForLog} bytes=${state.packCache.size} ` +
            `name=${params.name}`,
        );
        const ossStartedAt = Date.now();

        try {
          const ossResp = await net.fetch(state.initCache.uploadUrl, {
            method: 'PUT',
            body: new Uint8Array(state.packCache.buffer),
            headers: {
              'Content-Type': 'application/zip',
            },
          });
          const elapsedMs = Date.now() - ossStartedAt;
          if (ossResp.ok) {
            ossOk = true;
            log.debug(`[publish:oss] PUT ok | status=${ossResp.status} elapsedMs=${elapsedMs}`);
          } else if (ossResp.status === 403) {
            ossExpired = true;
            const body = await ossResp.text().catch(() => '<read body failed>');
            log.warn(
              `[publish:oss] PUT 403 expired | elapsedMs=${elapsedMs} body=${body.slice(0, 500)}`,
            );
          } else {
            const body = await ossResp.text().catch(() => '<read body failed>');
            const headersObj: Record<string, string> = {};
            ossResp.headers.forEach((v, k) => (headersObj[k] = v));
            ossFailDetail =
              `OSS PUT ${ossResp.status} ${ossResp.statusText}\n` +
              `url: ${urlForLog}\n` +
              `headers: ${JSON.stringify(headersObj)}\n` +
              `body: ${body.slice(0, 800)}`;
            log.error(
              `[publish:oss] PUT failed | status=${ossResp.status} statusText=${ossResp.statusText} ` +
                `elapsedMs=${elapsedMs}\nheaders=${JSON.stringify(headersObj)}\nbody=${body.slice(0, 1500)}`,
            );
          }
        } catch (err) {
          const elapsedMs = Date.now() - ossStartedAt;
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          ossFailDetail = `OSS PUT network error\n` + `url: ${urlForLog}\n` + `error: ${errMsg}`;
          log.error(
            `[publish:oss] PUT exception | elapsedMs=${elapsedMs} err=${errMsg}\nstack=${errStack ?? '(no stack)'}`,
          );
        }

        if (isCancelled()) {
          this.emitProgress(
            { phase: 'failed', name: params.name, errorCode: 'CANCELLED', message: '已取消' },
            onProgress,
          );
          return { success: false, errorCode: 'CANCELLED' };
        }

        if (ossExpired) {
          state.initCache = undefined;
          state.packCache = undefined;
          this.emitProgress(
            {
              phase: 'failed',
              name: params.name,
              errorCode: 'OSS_PUT_EXPIRED',
              message: '上传链接已过期,请重新发布',
            },
            onProgress,
          );
          return { success: false, errorCode: 'OSS_PUT_EXPIRED' };
        }

        if (!ossOk) {
          this.emitProgress(
            {
              phase: 'failed',
              name: params.name,
              errorCode: 'OSS_PUT_FAILED',
              message: ossFailDetail || '上传失败,请重试',
            },
            onProgress,
          );
          return { success: false, errorCode: 'OSS_PUT_FAILED' };
        }

        // ── 步骤 6: publish/commit ───────────────────────────────────────
        this.emitProgress({ phase: 'commit' }, onProgress);
        if (isCancelled()) {
          this.emitProgress(
            { phase: 'failed', name: params.name, errorCode: 'CANCELLED', message: '已取消' },
            onProgress,
          );
          return { success: false, errorCode: 'CANCELLED' };
        }

        try {
          const commitBody: Record<string, unknown> = {
            ossKey: state.initCache.ossKey,
            slug: params.name,
            version: state.initCache.nextVersion,
            ...(params.changelog ? { changelog: params.changelog } : {}),
          };
          if (params.displayName) commitBody.displayName = params.displayName;
          if (params.summary) commitBody.summary = params.summary;
          if (params.description) commitBody.description = params.description;
          if (params.isFirstPublish) {
            commitBody.tags = tags;
            commitBody.visibility =
              params.visibility === 'PUBLIC'
                ? 'public'
                : params.visibility === 'PRIVATE'
                  ? 'private'
                  : 'shared';
            if (params.deptTeamSlug) commitBody.deptTeamSlug = params.deptTeamSlug;
            if (params.teamSlug) commitBody.teamSlug = params.teamSlug;
            if (params.visibleSlugs !== undefined) commitBody.visibleSlugs = params.visibleSlugs;
          }

          log.debug(
            `[publish:commit] sending | slug=${params.name} version=${state.initCache.nextVersion} ` +
              `firstPublish=${params.isFirstPublish}`,
          );

          await skillhubApiFetch('/api/skills-hub/skills/publish/commit', {
            method: 'POST',
            body: commitBody,
          });

          // ── 步骤 7: commit 成功 → 立刻确认本地 ───────────────────────────
          const publishedVersion = state.initCache!.nextVersion;
          // commit 是不可逆的服务端副作用。此后即使用户登出或进入本地模式，
          // 也必须完成本地对账并报告成功，不能把已上线版本误报为 CANCELLED。
          publishSucceeded = true;

          await writeSnapshot(params.absolutePath, params.name).catch((err) =>
            log.warn('[publish] writeSnapshot failed (non-fatal):', err),
          );
          await syncPublishedRegistry(
            params.name,
            params.absolutePath,
            publishedVersion,
            folderHash,
            params.isFirstPublish
              ? params.visibility === 'DEPARTMENT_SCOPED'
                  ? 'team'
                  : null
              : undefined,
          ).catch((err) => log.warn('[publish] registry sync failed (non-fatal):', err));

          this.emitProgress(
            { phase: 'done', name: params.name, version: publishedVersion },
            onProgress,
          );
          // 公开发布完成机审后会进入 pending，等待 Platform 人工审核。收到 pending 后
          // 结束本轮轮询；用户主动刷新列表或详情时再读取最新审核状态。
          this.startScanPoll(params.name, publishedVersion);
          return { success: true, result: { name: params.name, version: publishedVersion } };
        } catch (err) {
          if (isCancelled()) {
            this.emitProgress(
              { phase: 'failed', name: params.name, errorCode: 'CANCELLED', message: '已取消' },
              onProgress,
            );
            return { success: false, errorCode: 'CANCELLED' };
          }
          if (err instanceof ServerApiError && err.code === 'VERSION_RACE') {
            if (versionRaceRetries < 2) {
              versionRaceRetries++;
              state.initCache = undefined;
              continue;
            }
          }
          const code = serverErrorToCode(err);
          this.emitProgress(
            {
              phase: 'failed',
              name: params.name,
              errorCode: code,
              message: err instanceof Error ? err.message : String(err),
            },
            onProgress,
          );
          return { success: false, errorCode: code };
        }
      }
    } catch (err) {
      const code = isCancelled() ? 'CANCELLED' : unhandledPublishErrorToCode(err);
      const message = isCancelled() ? '已取消' : err instanceof Error ? err.message : String(err);
      if (isCancelled()) {
        log.debug(`[publish] cancelled | name=${params.name}`);
      } else {
        log.error(`[publish] unexpected failure | name=${params.name} code=${code}:`, err);
      }
      this.emitProgress(
        {
          phase: 'failed',
          name: params.name,
          errorCode: code,
          message,
        },
        onProgress,
      );
      return { success: false, errorCode: code, error: message };
    } finally {
      if (this.current === state) {
        this.current = null;
      }
      if (!publishSucceeded && originalSkillMd !== null) {
        const skillMdPath = path.join(params.absolutePath, 'SKILL.md');
        await fs.promises.writeFile(skillMdPath, originalSkillMd, 'utf-8').catch((err) => {
          log.warn(`[publish] SKILL.md restore on failure failed: ${err}`);
        });
      }
    }
  }

  /** 停止 dialog-scoped scan 轮询（dialog 关闭时调用） */
  stopScanPoll(): void {
    this.scanPollGeneration++;
    if (this.activeScanPoll) {
      clearTimeout(this.activeScanPoll.timer);
      this.activeScanPoll = null;
    }
  }

  startScanPoll(slug: string, version: string): void {
    this.stopScanPoll();
    const generation = this.scanPollGeneration;
    const isCurrentPoll = () =>
      this.scanPollGeneration === generation &&
      this.activeScanPoll?.slug === slug &&
      this.activeScanPoll?.version === version;
    const poll = async (): Promise<void> => {
      try {
        const result = await this.getScanStatus(slug, version);
        if (!isCurrentPoll()) return;
        this.emitProgress({
          phase: 'scan-status',
          name: slug,
          version,
          status: result.status,
          gates: result.gates,
        });

        if (isTerminalScanStatus(result.status) || isPendingManualReviewStatus(result.status)) {
          if (!isCurrentPoll()) return;
          this.activeScanPoll = null;
          this.emitProgress({
            phase: 'scan-result',
            name: slug,
            version,
            status: result.status,
            gates: result.gates,
          });
          return;
        }
      } catch (err) {
        if (!isCurrentPoll()) return;
        log.warn(`[scan-poll] status lookup failed for ${slug}@${version}:`, err);
      }
      if (isCurrentPoll()) {
        const pollState = this.activeScanPoll;
        if (pollState) {
          pollState.timer = setTimeout(() => void poll(), this.scanPollIntervalMs);
        }
      }
    };
    const timer = setTimeout(() => void poll(), this.scanPollIntervalMs);
    this.activeScanPoll = { slug, version, timer };
  }

  private async getScanStatus(slug: string, version: string): Promise<ScanStatusResponse> {
    return skillhubApiFetch<ScanStatusResponse>(
      `/api/skills-hub/skills/${encodeURIComponent(slug)}/scan?version=${encodeURIComponent(version)}`,
      { cache: 'no-store', headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    );
  }

  private emitProgress(event: PublishProgressEvent, localProgress?: ProgressCb): void {
    localProgress?.(event);
    this.onProgress?.(event);
  }
}
