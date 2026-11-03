/**
 * Models the speaker gate downloads the first time a user turns it on. Both
 * desktop and mobile fetch the same files from Cindy's CDN, addressed by
 * content hash, and verify the hash before use.
 *
 * Sources (ONNX files as published by the sherpa-onnx project):
 * - Silero VAD (MIT): https://github.com/snakers4/silero-vad
 * - 3D-Speaker CAM++ zh/en "advanced" (Apache-2.0, per its ModelScope card
 *   iic/speech_campplus_sv_zh_en_16k-common_advanced):
 *   https://github.com/modelscope/3D-Speaker
 *
 * Changing a model means a new hash, so a new CDN object; clients holding the
 * old file simply download the new one. Old files are removed on next check.
 */
export type SpeakerModelAsset = {
  role: 'vad' | 'embedding';
  /** Name kept on disk, also used in logs. */
  fileName: string;
  sha256: string;
  bytes: number;
};

export const SPEAKER_MODEL_ASSETS: readonly SpeakerModelAsset[] = [
  {
    role: 'vad',
    fileName: 'silero_vad.onnx',
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    bytes: 643_854,
  },
  {
    role: 'embedding',
    fileName: '3dspeaker_campplus_zh_en_16k_advanced.onnx',
    sha256: 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2',
    bytes: 28_281_164,
  },
];

export const SPEAKER_MODEL_TOTAL_BYTES = SPEAKER_MODEL_ASSETS.reduce(
  (sum, asset) => sum + asset.bytes,
  0,
);

/** Object path below the region's `cdnBaseUrl`. */
export function speakerModelCdnPath(asset: SpeakerModelAsset): string {
  return `voice-models/${asset.sha256}.onnx`;
}

/** Local file name: the hash keeps an updated model from reusing a stale file. */
export function speakerModelLocalName(asset: SpeakerModelAsset): string {
  return `${asset.sha256.slice(0, 16)}-${asset.fileName}`;
}

export function speakerModelAsset(role: SpeakerModelAsset['role']): SpeakerModelAsset {
  const asset = SPEAKER_MODEL_ASSETS.find((candidate) => candidate.role === role);
  if (!asset) throw new Error(`missing speaker model asset: ${role}`);
  return asset;
}
