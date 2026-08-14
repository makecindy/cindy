import { Platform } from 'react-native';
import {
  composerTextPaddingForPlatform,
  type ComposerTextPlatform,
} from '@/session/composerTextMetrics';

const composerTextPlatform: ComposerTextPlatform = Platform.OS === 'ios'
  ? 'ios'
  : Platform.OS === 'android'
    ? 'android'
    : 'default';

const composerTextPadding = composerTextPaddingForPlatform(composerTextPlatform);

/** Platform-specific padding adapter; the base metrics remain node-testable. */
export const COMPOSER_TEXT_PADDING_TOP = composerTextPadding.top;
export const COMPOSER_TEXT_PADDING_BOTTOM = composerTextPadding.bottom;
