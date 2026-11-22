import { useState } from 'react';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useIsFocused } from 'expo-router/react-navigation';
import { useLoopingAnimation } from '@/hooks/useLoopingAnimation';

function Loop({ source }: { source: number | string }) {
  const [ready, setReady] = useState(false);
  const player = useVideoPlayer(source, instance => {
    instance.muted = true;
    instance.loop = true;
    instance.audioMixingMode = 'mixWithOthers';
    instance.keepScreenOnWhilePlaying = false;
    instance.allowsExternalPlayback = false;
    instance.play();
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  return <VideoView player={player} nativeControls={false} allowsVideoFrameAnalysis={false}
    contentFit="fill" onFirstFrameRender={() => setReady(true)}
    style={{ position: 'absolute', width: '100%', height: '100%', opacity: ready && status !== 'error' ? 1 : 0 }} />;
}

export function WallpaperMotion({ source }: { source: number | string }) {
  const focused = useIsFocused();
  const play = useLoopingAnimation(focused);
  return play ? <Loop source={source} /> : null;
}
