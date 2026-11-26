/** Opens the link the instance resolved for its current connection. */
export async function openCloudExternal(resolveUrl: () => Promise<string>): Promise<void> {
  const result = await window.electronAPI.openExternal(await resolveUrl());
  if (!result.success) throw new Error('OPEN_FAILED');
}
