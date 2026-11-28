import { formatTaskTopicTitle } from '@cindy/maker-shared/session-title';
import { t } from '../i18n.desktop.js';

export interface GroupTaskTopic {
  text: string;
  participant: string;
  channel: string;
}

/** Long-running conversations identify the participant and room; topics identify their subject. */
export function groupTaskName(room: string, participant: string, subject?: string) {
  const channel = t('bots.groupChat.mask.catchup.main');
  if (subject === undefined) return { title: formatTaskTopicTitle(room, channel, { participant }) };
  const topic: GroupTaskTopic = { text: subject, participant, channel };
  return { title: formatTaskTopicTitle(subject || room, channel, { participant }), topic };
}
