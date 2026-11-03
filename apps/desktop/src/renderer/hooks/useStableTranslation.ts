import { useTranslation } from 'react-i18next';

// react-i18next includes options in its subscription dependencies. Its default
// empty object is new on every render; share it without changing language events.
const DEFAULT_OPTIONS = {};

export function useStableTranslation() {
  return useTranslation(undefined, DEFAULT_OPTIONS);
}
