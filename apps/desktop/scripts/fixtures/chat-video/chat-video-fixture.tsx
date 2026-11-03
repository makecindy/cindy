import { mountPage } from '../../ui-page/harness';
import { ChatVideoView } from '../../../src/renderer/components/chat/ChatVideoView';
import { VideoLightbox } from '../../../src/renderer/components/chat/VideoLightbox';
import { useLayoutEffect } from 'react';
import '../../../src/renderer/components/chat/rich-answer.css';

// Anonymous 640 x 360 VP8 sample: ffmpeg -f lavfi -i color=c=gray:s=640x360:r=5 -t 1 -c:v libvpx -f webm pipe:1.
// Keep decoding deterministic in hidden Electron windows; no user media or network.
const src =
  'data:video/webm;base64,GkXfowEAAAAAAAAfQoaBAUL3gQFC8oEEQvOBCEKChHdlYm1Ch4ECQoWBAhhTgGcB/////////xFNm3RALE27i1OrhBVJqWZTrIHlTbuMU6uEFlSua1OsggEjTbuMU6uEElTDZ1OsggFs7AEAAAAAAACqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmAQAAAAAAADIq17GDD0JATYCNTGF2ZjU4LjI0LjEwMVdBjUxhdmY1OC4yNC4xMDFEiYhAj0AAAAAAABZUrmsBAAAAAAAAPa4BAAAAAAAANNeBAXPFgQGcgQAitZyDdW5khoVWX1ZQOIOBASPjg4QL68IA4AEAAAAAAAAIsIICgLqCAWgSVMNnAQAAAAAAAHtzcwEAAAAAAAAuY8ABAAAAAAAAAGfIAQAAAAAAABpFo4dFTkNPREVSRIeNTGF2ZjU4LjI0LjEwMXNzAQAAAAAAADljwAEAAAAAAAAEY8WBAWfIAQAAAAAAACFFo4dFTkNPREVSRIeUTGF2YzU4LjQyLjEwMiBsaWJ2cHgfQ7Z1AQAAAAAABXzngQCjQayBAACAcDMAnQEqgAJoAQBHCIWFiIWEiAICAAYWBh17c2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2TnD2RQAP5oAKO0gQDIAJEFAAEQEAAYABhYL/QX+gYGC/0DAAiABAAAhtBZjovcpNfnKsZFZkJPsxRhoLKgAKNBrIEBkIBwMwCdASqAAmgBAEcIhYWIhYSIAgIABhYGHXtzZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZOcPZFAA/mgAo7SBAlgAkQUAARAQABgAGFgv9Bf6BgYL/QMACIAEAACG0FmOi9yk1+cqxkVmQk+zFGGgsqAAo0GsgQMggHAzAJ0BKoACaAEARwiFhYiFhIgCAgAGFgYde3Nk5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9k5w9kUAD+aAA=';

function MenuSample({ lightbox }: { lightbox: boolean }) {
  useLayoutEffect(() => {
    // Keep a local-media identity for the production menu, supply anonymous bytes
    // directly because the isolated UI runner has no Cindy protocol handlers.
    document.querySelector('video')!.src = src;
  }, []);
  const localSrc = 'cindy-media://blobs/ui-video.webm';
  return (
    <>
      {lightbox ? (
        <VideoLightbox src={localSrc} onClose={() => { document.body.dataset.videoLightboxClosed = 'true'; }} />
      ) : (
        <ChatVideoView src={localSrc} filename="Menu sample" variant="tool-output" />
      )}
    </>
  );
}

mountPage({
  host: {
    copyMediaToClipboard: async () => {
      document.body.dataset.videoMenuAction = 'copy';
      return { success: true };
    },
    showItemInFolder: async () => {
      document.body.dataset.videoMenuAction = 'reveal';
      return { success: true };
    },
  },
  render: (ctx) =>
    ctx.case.startsWith('menu-') ? (
      <MenuSample lightbox={ctx.case === 'menu-lightbox'} />
    ) : (
      <div className="rich-answer p-6">
        <div className="rich-answer-media">
          <ChatVideoView src={src} filename="Playback sample" variant="tool-output" />
        </div>
      </div>
    ),
});
