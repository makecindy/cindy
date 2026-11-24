import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { youtubeVideo } from '@cindy/maker-shared/rich-answer';
import { Button } from '@/components/ui/button';
import { BROWSER_PARTITION } from '@/../shared/webviewPartition';
import { CURRENT_APP_ID } from '@/../shared/brandRegion';

/** Click-to-load site player using the built-in browser’s persistent login session. */
export function VideoSitePreview({ src, title }: { src: string; title: string }) {
  const video = youtubeVideo(src);
  return video ? <YoutubePreview key={video.embed} video={video} title={title} /> : null;
}
function YoutubePreview({ video, title }: { video: NonNullable<ReturnType<typeof youtubeVideo>>; title: string }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const restorePlayFocus = useRef(false);
  useEffect(() => {
    if (!active || !host.current) return;
    const target = host.current;
    const guest = document.createElement('webview');
    guest.setAttribute('partition', BROWSER_PARTITION);
    // Reuse the browser's session and popup flow so login can return to this player.
    guest.setAttribute('allowpopups', '');
    guest.setAttribute('httpreferrer', `https://${CURRENT_APP_ID}/`);
    guest.setAttribute('src', video.embed);
    guest.setAttribute('title', title);
    guest.setAttribute('style', 'display:flex;width:100%;height:100%');
    const stop = () => {
      if (!guest.isConnected) return;
      guest.remove();
      setActive(false);
    };
    let fullscreen = false;
    const observer = new IntersectionObserver((entries) => {
      if (!fullscreen && entries.at(-1)?.isIntersecting === false) stop();
    });
    const enterFullscreen = () => { fullscreen = true; };
    const leaveFullscreen = () => {
      fullscreen = false;
      // Resample the inline slot once native fullscreen returns to it.
      observer.unobserve(target);
      observer.observe(target);
    };
    const failed = (event: Event) => {
      const failure = event as Electron.DidFailLoadEvent;
      if (failure.isMainFrame && failure.errorCode !== -3) stop();
    };
    guest.addEventListener('did-fail-load', failed);
    guest.addEventListener('render-process-gone', stop);
    guest.addEventListener('enter-html-full-screen', enterFullscreen);
    guest.addEventListener('leave-html-full-screen', leaveFullscreen);
    target.appendChild(guest);
    observer.observe(target);
    return () => {
      observer.disconnect();
      guest.removeEventListener('did-fail-load', failed);
      guest.removeEventListener('render-process-gone', stop);
      guest.removeEventListener('enter-html-full-screen', enterFullscreen);
      guest.removeEventListener('leave-html-full-screen', leaveFullscreen);
      guest.remove();
    };
  }, [active, video.embed, title]);
  return (
    <div className="rich-answer-site-video flex flex-col gap-2">
      {active ? <div ref={host} style={{ width: '100%', aspectRatio: '16 / 9', minHeight: 200 }} /> : (
        <button
          type="button"
          className="w-full text-left"
          onClick={() => setActive(true)}
          aria-label={t('richAnswer.playVideo')}
          ref={(button) => {
            if (button && restorePlayFocus.current) {
              restorePlayFocus.current = false;
              button.focus({ preventScroll: true });
            }
          }}
        >
          <img src={video.poster} alt={title} className="block w-full" style={{ aspectRatio: '16 / 9', objectFit: 'contain' }} />
          <span>{t('richAnswer.playVideo')}</span>
        </button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <a href={video.watch} target="_blank" rel="noopener noreferrer" className="underline">{t('richAnswer.openVideoSource')}</a>
        {active && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => {
              restorePlayFocus.current = true;
              setActive(false);
            }}
          >
            {t('chat.lightbox.close')}
          </Button>
        )}
      </div>
    </div>
  );
}
