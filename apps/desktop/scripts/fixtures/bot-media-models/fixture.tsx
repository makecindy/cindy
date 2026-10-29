import { useState } from 'react';
import { mountPage, ctx } from '../../ui-page/harness';
import { BotMediaModelEditor } from '../../../src/renderer/features/bots/BotMediaModelEditor';
import type { TeammateMediaModels } from '@cindy/maker-shared/teammate-media-models';

const vision = { providerId: 'vision-account', modelId: 'vision-model' };
const image = { providerId: 'image-account', modelId: 'image-model' };
const video = { providerId: 'video-account', modelId: 'video-model' };
function Fixture() {
  const [value, setValue] = useState<TeammateMediaModels | null>(ctx.case === 'default' ? null : {
    vision: { primary: vision, fallback: null }, image, video,
  });
  return <main data-media-settings-fixture className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
    <BotMediaModelEditor value={value} onChange={setValue} />
  </main>;
}
void mountPage({ host: () => ({ localDb: { bots: { mediaModels: async () => {
  if (ctx.case === 'unavailable') throw new Error('Synthetic catalog unavailable');
  return ({
  vision: [{ ...vision, label: 'Vision model · Vision account' }],
  image: [{ ...image, label: 'Image model with a long display name · Image account' }],
  video: [{ ...video, label: 'Video model · Video account' }],
}); } } } }), render: () => <Fixture /> });
