import {
  peekHostMediaModel,
  runHostImageEdit,
  runHostImageToVideo,
} from '../cindy-brain/index.js';

export function peekDesktopCompanionMedia(): { image: boolean; video: boolean } {
  try {
    return {
      image: Boolean(peekHostMediaModel('image.edit')),
      video: Boolean(peekHostMediaModel('video.edit')),
    };
  } catch {
    return { image: false, video: false };
  }
}

export function generateDesktopCompanionStill(params: {
  prompt: string;
  refPath: string;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  return runHostImageEdit({
    prompt: params.prompt,
    imagePaths: [params.refPath],
    aspectRatio: '3:2',
  });
}

export function generateDesktopCompanionVideo(params: {
  prompt: string;
  stillPath: string;
  assertStillValid: () => void;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  return runHostImageToVideo({
    prompt: params.prompt,
    imagePaths: [params.stillPath],
    assertStillValid: params.assertStillValid,
    ratio: '16:9',
    duration: 6,
    audio: false,
  });
}
