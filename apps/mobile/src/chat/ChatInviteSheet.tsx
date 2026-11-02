import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatInvite, type ChatInviteSheetProps } from './useChatInvite';
import { ChatInviteView } from './ChatInviteView';

export function ChatInviteSheet(props: ChatInviteSheetProps) {
  const invite = useChatInvite(props);
  // Host clears an external token before native dismissal. Keep its presentation mode
  // until the next visible presentation, so edit/input rows do not appear during closing.
  const presentedManual = useRef(invite.manual);
  if (props.visible) presentedManual.current = invite.manual;
  const { t, i18n } = useTranslation();
  const preview = invite.preview;
  const alreadyMember = invite.phase === 'preview' && preview?.joined === true;
  const expiredAt = alreadyMember ? undefined : preview?.expiresAt;
  const validity = typeof expiredAt === 'string' ? t('groupChat.invitation.until', {
    date: new Date(expiredAt).toLocaleString(i18n.language),
  }) : undefined;
  const busy = invite.phase === 'reading' || invite.phase === 'joining';
  const input = presentedManual.current && (invite.phase === 'input' || invite.error === 'format');
  const canRetry = !!invite.error && ['network', 'uncertain', 'forbidden', 'auth'].includes(invite.error);
  const label = input ? t('groupChat.invitation.previewInvite')
    : invite.phase === 'joining' ? t('groupChat.invitation.joining')
    : canRetry ? t(invite.error === 'uncertain' ? 'groupChat.invitation.retryAccept' : 'groupChat.invitation.retryInvite')
    : invite.error ? t('groupChat.invitation.close') : t(alreadyMember ? 'groupChat.invitation.openGroup' : 'groupChat.invitation.accept');
  return <ChatInviteView visible={props.visible} model={{ ...invite, manual: presentedManual.current }} input={input} validity={validity}
    otherInvitationMessage={props.hasOtherInvitation ? t('groupChat.invitation.otherInvitation') : undefined}
    title={input ? t('groupChat.invitation.join') : invite.phase === 'reading' ? t('groupChat.invitation.loadingInvite')
      : invite.error ? t(`groupChat.invitation.titles.${invite.error}`) : ''}
    message={invite.error ? t(invite.error === 'format' && !input ? 'groupChat.invitation.externalFormatError' : `groupChat.invitation.errors.${invite.error}`) : input ? t('groupChat.invitation.joinDescription') : alreadyMember ? t('groupChat.invitation.alreadyMember') : undefined}
    primary={invite.phase !== 'reading' ? {
      label, busy, disabled: input && !invite.input.trim(),
      onPress: input ? invite.read : canRetry ? invite.retry : invite.error ? invite.close : invite.accept,
    } : undefined} />;
}
export type ChatInviteModel = ReturnType<typeof useChatInvite>;
