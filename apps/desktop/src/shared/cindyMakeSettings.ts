/** Device-local Cindy Make preferences shared across Main, preload and Settings. */
export interface CindyMakeSettings {
  /** Fetch and adopt the latest official source before a personal build starts. */
  syncLatestBeforeBuild: boolean;
}

export const DEFAULT_CINDY_MAKE_SETTINGS: CindyMakeSettings = {
  syncLatestBeforeBuild: false,
};
