import { i18n } from '@/i18n';
import {
  formatByteSize,
  type RemoteFilePreviewKind,
  type RemoteTextFilePreviewResultLike,
  type TextFilePreviewState,
} from '@cindy/maker-shared/file-preview';

export {
  basenameRemotePath,
  extractRemoteFileExt,
  formatByteSize,
  isHtmlFilePreviewCandidate,
  isTextFilePreviewCandidate,
  remoteFilePreviewKind,
  type RemoteFilePreviewKind,
  type RemoteTextFilePreviewResultLike,
  type TextFilePreviewState,
} from '@cindy/maker-shared/file-preview';

export function nonTextFilePreviewStatusText(kind: RemoteFilePreviewKind): string {
  return i18n.t(`files.presentation.preview.nonText.${kind}`);
}

export function textPreviewStatusText(
  state: TextFilePreviewState,
  canPreview: boolean,
  kind: RemoteFilePreviewKind = 'text',
): string {
  if (kind !== 'text') return nonTextFilePreviewStatusText(kind);
  if (!canPreview) return i18n.t('files.presentation.preview.pathOnly');
  if (state.status === 'loading') return i18n.t('files.presentation.preview.loading');
  if (state.status === 'ready') {
    return i18n.t('files.presentation.preview.ready', { size: formatByteSize(state.size) });
  }
  if (state.status === 'unavailable') return state.message;
  return i18n.t('files.presentation.preview.idle');
}

export function describeTextPreviewFailure(result: RemoteTextFilePreviewResultLike): string {
  const size = formatByteSize(result.size);
  if (result.reason === 'oversize') {
    return i18n.t('files.presentation.preview.failure.oversize', {
      limit: result.limitMb ? `${result.limitMb} MB` : '',
      size,
    });
  }
  if (result.reason === 'forbidden') return i18n.t('files.presentation.preview.failure.forbidden');
  if (result.reason === 'not_found') return i18n.t('files.presentation.preview.failure.notFound');
  if (result.reason === 'read_failed') {
    return result.error
      ? i18n.t('files.presentation.preview.failure.readFailedWithError', { error: result.error })
      : i18n.t('files.presentation.preview.failure.readFailed');
  }
  return result.error || i18n.t('files.presentation.preview.failure.default');
}
