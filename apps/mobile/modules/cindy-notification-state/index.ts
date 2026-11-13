import { requireOptionalNativeModule } from 'expo-modules-core';
export default requireOptionalNativeModule<{ retire(recipientId: string, ids: string[]): Promise<void> }>('CindyNotificationState');
