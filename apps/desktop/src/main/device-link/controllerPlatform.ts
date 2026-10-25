export { isDesktopPlatform, isMobilePlatform, isSupportedControllerPlatform } from '@cindy/app-runtime/controllerPlatform';
import { createControllerPlatforms } from '@cindy/app-runtime/controllerPlatform';
export const { setControllerPlatform, getControllerPlatform, clearControllerPlatforms } = createControllerPlatforms();
