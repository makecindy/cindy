/**
 * The plugin page's prompts (a notice with one button, or a confirmation): on Android the app's themed card, the same as
 * the shared-task confirmations (light and dark follow the app; the text scrolls above buttons of their own height).
 * iOS has its own sheet (usePluginPrompt.ios.tsx): the system alert cuts its buttons at the largest text sizes.
 */
export { useSharedTaskConfirmation as usePluginPrompt } from "@/session/useSharedTaskConfirmation";
