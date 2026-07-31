export const RELEASE_NOTES_CHANNELS = {
  FETCH: "release-notes:fetch",
  FETCH_INDEX: "release-notes:fetch-index",
} as const;

export type RELEASE_NOTESChannel = typeof RELEASE_NOTES_CHANNELS[keyof typeof RELEASE_NOTES_CHANNELS];
