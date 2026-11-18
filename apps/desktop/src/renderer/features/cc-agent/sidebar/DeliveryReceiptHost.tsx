import { useEffect, useState } from 'react';

import { DeliveryReceiptDialog } from './DeliveryReceiptDialog';
import {
  subscribeDeliveryReceiptRequest,
  takePendingDeliveryReceipt,
} from './deliveryReceiptRequest';

export function DeliveryReceiptHost() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    const pending = takePendingDeliveryReceipt();
    if (pending) setSessionId(pending);
    return subscribeDeliveryReceiptRequest(setSessionId);
  }, []);
  if (!sessionId) return null;
  return <DeliveryReceiptDialog sessionId={sessionId} onClose={() => setSessionId(null)} />;
}
