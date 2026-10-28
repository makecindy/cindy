/** Renderer-safe material prepared for manual sharing; contains no delivery or permission token. */
export interface ShareContent {
  title: string;
  url: string;
  imageSvg: string;
  attribution?: { displayName: string };
}

export interface ShareOptions {
  includeAttribution: boolean;
}
