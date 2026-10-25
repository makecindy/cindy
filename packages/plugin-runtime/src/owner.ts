export interface PluginOwner {
  mode: 'signed-out' | 'local' | 'cloud';
  dataOwnerId: string | null;
  generation: number;
}
