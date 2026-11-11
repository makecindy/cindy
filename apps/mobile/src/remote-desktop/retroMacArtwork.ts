/** Static Metro assets: no download, native dependency or generated runtime image. */
export const retroMacArtwork = {
  display: require("../../assets/retro-mac/display.webp"),
  compact: require("../../assets/retro-mac/display-compact.webp"),
  edge: require("../../assets/retro-mac/display-edge.webp"),
  darkKeycap: require("../../assets/retro-mac/keycap-dark.webp"),
  trackpoint: require("../../assets/retro-mac/trackpoint.webp"),
  keycap: require("../../assets/retro-mac/keycap.webp"),
  displays: {
    macii: require("../../assets/retro-mac/macii-display.webp"),
    powerbook: require("../../assets/retro-mac/powerbook-display.webp"),
    thinkpad: require("../../assets/retro-mac/thinkpad-display.webp"),
  },
  /** Plain bases with an empty keyboard well, drawn for the classic layout. */
  decks: {
    classic: {
      deck: require("../../assets/retro-mac/classic-deck.webp"),
      control: require("../../assets/retro-mac/classic-control.webp"),
    },
    macii: {
      deck: require("../../assets/retro-mac/macii-deck.webp"),
      control: require("../../assets/retro-mac/macii-control.webp"),
    },
    powerbook: {
      deck: require("../../assets/retro-mac/powerbook-deck.webp"),
      control: require("../../assets/retro-mac/powerbook-control.webp"),
    },
    thinkpad: {
      deck: require("../../assets/retro-mac/thinkpad-deck.webp"),
      control: require("../../assets/retro-mac/thinkpad-control.webp"),
    },
  },
};
