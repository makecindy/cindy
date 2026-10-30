/** Optional payload extension of maker:input:get-projection; old hosts omit it. */
export type InputDeliveryState = "pending" | "accepted" | "removed" | "unknown";
export interface InputDeliveryReceipt {
  clientId: string;
  state: InputDeliveryState;
}
export interface InputDeliveryProjection {
  inputDeliveryVersion?: 1;
  deliveryReceipts?: InputDeliveryReceipt[];
}

/** Bound work before querying durable delivery state. No message content is returned. */
export function readInputDeliveryClientIds(
  options: unknown,
): string[] | undefined {
  if (
    !options ||
    typeof options !== "object" ||
    !("deliveryClientIds" in options)
  )
    return undefined;
  const ids = (options as { deliveryClientIds?: unknown }).deliveryClientIds;
  if (
    !Array.isArray(ids) ||
    ids.length > 64 ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 256)
  ) {
    throw new Error(
      "deliveryClientIds must contain at most 64 nonempty IDs (256 characters each)",
    );
  }
  return [...new Set(ids as string[])];
}
