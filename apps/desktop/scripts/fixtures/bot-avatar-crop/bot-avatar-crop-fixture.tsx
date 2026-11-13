import { useState } from 'react';
import { mountPage, forbid } from '../../ui-page/harness';
import { BotPortraitPicker } from '../../../src/renderer/features/bots/BotPortraitPicker';
import cindy from '../../../src/renderer/assets/bot-presets/cindy.png';

function Portrait() {
  const [value, setValue] = useState(cindy);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <BotPortraitPicker value={value} onChange={setValue} />
      <output data-testid="avatar-result" className="hidden">
        {value}
      </output>
    </div>
  );
}
mountPage({
  host: {
    profileUpdate: forbid('profileUpdate'),
    // Component-only host substitute. Real Electron prepares HDR through
    // profileEdit.chooseAvatarSource; that path has its own main-process tests.
    localDb: {
      bots: {
        chooseAvatarSource: async () => {
          const supplied = (window as unknown as { __botAvatarUpload?: string }).__botAvatarUpload;
          if (supplied) return { canceled: false, previewDataUrl: supplied };
          const image = new Image();
          image.src = cindy;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          canvas.getContext('2d')!.drawImage(image, 0, 0);
          return { canceled: false, previewDataUrl: canvas.toDataURL() };
        },
      },
    },
  },
  render: () => <Portrait />,
});
