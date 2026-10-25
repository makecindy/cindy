import { createNativeSessionMetadata } from '@cindy/runtime-db/nativeSessionMetadata';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
export type * from '@cindy/runtime-db/nativeSessionMetadata';
export const { projectNativeSessionMetadata } = createNativeSessionMetadata(() => getCurrentDbClientSnapshot());
