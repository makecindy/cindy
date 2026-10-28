import type { GeneratedFileRef } from '@/lib/generatedFiles';
import {
  deliverableFileExtension,
  isBotDeliverableFile,
  isBotSupportingFile,
} from '@cindy/maker-shared/bot-deliverable';

export const generatedFileExtension = (file: GeneratedFileRef): string => deliverableFileExtension(file);

/**
 * 伙伴工作目录里的预览截图与临时文件仍然可取，但不能和真正成果并列。
 * 判断见 maker-shared `bot-deliverable`，与手机近况共用。
 */
export const isBotSupportingGeneratedFile = (file: GeneratedFileRef, workingDir?: string): boolean =>
  isBotSupportingFile(file, workingDir);

export const isBotPrimaryGeneratedFile = (file: GeneratedFileRef, workingDir?: string): boolean =>
  isBotDeliverableFile(file, workingDir);

export function partitionBotGeneratedFiles(files: readonly GeneratedFileRef[], workingDir?: string): {
  primary: GeneratedFileRef[];
  related: GeneratedFileRef[];
} {
  const primary: GeneratedFileRef[] = [];
  const related: GeneratedFileRef[] = [];
  for (const file of files) {
    (isBotPrimaryGeneratedFile(file, workingDir) ? primary : related).push(file);
  }
  return { primary, related };
}
