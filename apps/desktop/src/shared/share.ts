/** Renderer-safe material prepared for manual sharing; contains no delivery or permission token. */
export interface ShareContent {
  title: string;
  url: string;
  imageSvg: string;
  attribution?: { displayName: string };
}

/** A local package is only uploaded after the caller confirms this result. */
export type SharePreparation = ShareContent | { confirmationRequired: true };

export interface ShareOptions {
  includeAttribution: boolean;
}

/** Binds the clicked local installation without accepting a renderer filesystem path. */
export interface LocalPluginShareBinding {
  version: string;
  approvalToken: string;
}
