import {
  peekHostMediaModel,
  runHostImageEdit,
  runHostImageGenerate,
  runHostImageToVideo,
} from '../cindy-brain/index.js';

export function peekDesktopCompanionMedia(): { image: boolean; video: boolean } {
  try {
    return {
      image: Boolean(peekHostMediaModel('image.generate') || peekHostMediaModel('image.edit')),
      video: Boolean(peekHostMediaModel('video.edit')),
    };
  } catch {
    return { image: false, video: false };
  }
}

export function generateDesktopCompanionStill(params: {
  prompt: string;
  refPath: string | null;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  if (params.refPath) {
    return runHostImageEdit({
      prompt: params.prompt,
      imagePaths: [params.refPath],
      aspectRatio: '3:2',
    }).catch(() => runHostImageGenerate({ prompt: params.prompt, aspectRatio: '3:2' }));
  }
  return runHostImageGenerate({ prompt: params.prompt, aspectRatio: '3:2' });
}

export function generateDesktopCompanionVideo(params: {
  prompt: string;
  stillPath: string;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  return runHostImageToVideo({
    prompt: params.prompt,
    imagePaths: [params.stillPath],
    ratio: '16:9',
    duration: 6,
    audio: false,
  });
}
