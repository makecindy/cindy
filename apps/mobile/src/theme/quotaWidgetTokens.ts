/** Feature-local, user-reviewed subscription widget design. Not a change to the app theme.
 * Rings encode quota windows, never success/warning/error. Native resources are generated from here.
 */
export const quotaWidgetTokens = {
  inset: 16, ring: 42, stroke: 4.5, brandSize: 12, detailSize: 14,
  // Medium columns share three baseline-aligned rows; small cards keep their existing layout.
  medium: { informationTop: 66, valueSize: 32, primaryRowHeight: 38, secondaryRowHeight: 21, tertiaryRowHeight: 18, rowGap: 0, inlineGap: 4.5, primaryInlineGap: 3 },
  light: { widgetSurface: '#FFFFF8', widgetPrimary: '#1A1A1A', widgetSecondary: '#4D4D4A', quotaWeekly: '#DF0C27', quotaSession: '#315FA5', quotaScoped: '#44443F' },
  dark: { widgetSurface: '#121214', widgetPrimary: '#F0ECDF', widgetSecondary: '#BDBDBD', quotaWeekly: '#FF4B4B', quotaSession: '#7C9BC7', quotaScoped: '#EAE6DA' },
} as const;
