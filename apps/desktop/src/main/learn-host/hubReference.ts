/**
 * hubReference.ts —— /learn hub:<slug> 的市场 skill 参考材料读取。
 *
 * 主 SKILL.md 必须是完整内容;辅助文件是 best-effort 参考材料,可逐个跳过。
 */

import { createLogger } from '../logger';
import type { SkillhubCatalogScope } from '../../shared/skillhubCatalog';

const log = createLogger('learn-host:hub-reference');
const MAX_REFERENCE_FILES = 40;
const MAX_REFERENCE_FILE_BYTES = 512 * 1024;
// 省略清单本身也要有界:超大 skill 包(数百上千文件)会把逐文件的 omission 条目
// 灌进 learn prompt,内容 40 文件上限就形同虚设(Codex review #548)。逐条列到此
// 上限为止,其余收敛成一条「+N more」汇总。
const MAX_OMITTED_ENTRIES = 40;

interface HubInfoResult {
  info?: { description?: string | null } | null;
}

interface HubFileResult {
  file: {
    path: string;
    size: number;
    language: string;
    truncated: boolean;
    content: string;
  };
}

interface HubFilesResult {
  files: Array<{ path: string; size: number; language: string; truncated: boolean }>;
}

export interface HubSkillReferenceReader {
  info(slug: string, catalogScope?: SkillhubCatalogScope): Promise<HubInfoResult>;
  readPublishedFile(params: { name: string; path: string; catalogScope?: SkillhubCatalogScope }): Promise<HubFileResult>;
  getPublishedFiles(params: { name: string; catalogScope?: SkillhubCatalogScope }): Promise<HubFilesResult>;
}

export interface HubSkillReferenceOmission {
  path: string;
  reason: string;
}

export interface HubSkillReference {
  name: string;
  description: string;
  content: string;
  files?: Array<{ path: string; content: string }>;
  omittedFiles?: HubSkillReferenceOmission[];
}

export async function fetchHubSkillReference(
  marketService: HubSkillReferenceReader,
  slug: string,
  catalogScope?: SkillhubCatalogScope,
): Promise<HubSkillReference | null> {
  const infoRes = await marketService.info(slug, catalogScope);
  if (!('info' in infoRes) || !infoRes.info) return null;

  const fileRes = await marketService
    .readPublishedFile({ name: slug, path: 'SKILL.md', catalogScope })
    .catch(() => null);
  if (!fileRes || fileRes.file.truncated) return null;
  // 主 SKILL.md 同样吃单文件上限(Greptile review):server 未标 truncated 但超
  // 512KB 的主文件会整段进蒸馏 prompt,直接构造超大请求。主文件不可跳过 ——
  // 超限按不可用处理(与 truncated 同待遇),hub 源报 NOT_FOUND 由用户换源。
  if (fileRes.file.size > MAX_REFERENCE_FILE_BYTES || fileRes.file.content.length > MAX_REFERENCE_FILE_BYTES) {
    log.warn(`hub skill ${slug} primary SKILL.md exceeds ${MAX_REFERENCE_FILE_BYTES} bytes — treated as unavailable`);
    return null;
  }

  const files: Array<{ path: string; content: string }> = [];
  const omittedFiles: HubSkillReferenceOmission[] = [];
  // 有界追加:前 MAX_OMITTED_ENTRIES 条逐文件记录(保留可读的逐条原因),
  // 超出的只计数,循环结束后并成一条汇总 —— 保证注入 prompt 的清单尺寸有上界。
  let omittedOverflow = 0;
  const pushOmission = (path: string, reason: string): void => {
    if (omittedFiles.length < MAX_OMITTED_ENTRIES) {
      omittedFiles.push({ path, reason });
    } else {
      omittedOverflow++;
    }
  };
  try {
    const listing = await marketService.getPublishedFiles({ name: slug, catalogScope });
    let consideredReferenceFiles = 0;
    for (const meta of listing.files) {
      if (meta.path === 'SKILL.md') continue;
      if (consideredReferenceFiles >= MAX_REFERENCE_FILES) {
        pushOmission(meta.path, `not fetched; reference file limit is ${MAX_REFERENCE_FILES}`);
        continue;
      }
      consideredReferenceFiles++;
      if (meta.truncated) {
        pushOmission(meta.path, 'metadata marked the file as truncated');
        continue;
      }
      if (meta.size > MAX_REFERENCE_FILE_BYTES) {
        pushOmission(meta.path, `file is larger than ${MAX_REFERENCE_FILE_BYTES} bytes`);
        continue;
      }
      const one = await marketService
        .readPublishedFile({ name: slug, path: meta.path, catalogScope })
        .catch(() => null);
      if (!one) {
        pushOmission(meta.path, 'file read failed');
        continue;
      }
      if (one.file.truncated) {
        pushOmission(meta.path, 'file read returned truncated content');
        continue;
      }
      if (one.file.size > MAX_REFERENCE_FILE_BYTES) {
        pushOmission(meta.path, `file is larger than ${MAX_REFERENCE_FILE_BYTES} bytes`);
        continue;
      }
      files.push({ path: meta.path, content: one.file.content });
    }
  } catch (err) {
    log.warn('[learn-host] getPublishedFiles failed (reference files skipped):', err);
    pushOmission('*', 'published file listing failed');
  }
  if (omittedOverflow > 0) {
    omittedFiles.push({
      path: `(+${omittedOverflow} more files)`,
      reason: `omission list capped at ${MAX_OMITTED_ENTRIES} entries`,
    });
  }

  return {
    name: slug,
    description: infoRes.info.description ?? '',
    content: fileRes.file.content,
    files,
    ...(omittedFiles.length > 0 ? { omittedFiles } : {}),
  };
}
