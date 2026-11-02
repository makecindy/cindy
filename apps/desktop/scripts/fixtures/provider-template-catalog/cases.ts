import { BUNDLED_CATALOG } from '@cindy/model-providers';
// Enumerate the live bundled catalog; adding a template automatically adds browser cases.
export const presets = BUNDLED_CATALOG.presets ?? [];
export const deployments = ['sub2api', 'litellm', 'lmstudio', 'llamacpp', 'vllm'];
export const bindInput = (url: string) => url.replace(/\{([^}]+)\}/g, (_, key) => key === 'location' ? 'us-central1' : key === 'endpoint' ? 'relay.example/team' : 'ReviewAccount');
// Registry interfaceProfiles explicitly accept this input for both products,
// although only the Coding Plan uses it as its default runtime baseUrl.
// Keep an independent expectation: calling matchOfficialProviders here would
// let a recognition regression change both the expected and actual result.
const sharedInterfaceInputs: Record<string, string[]> = {
  'https://api.z.ai/api/coding/paas/v4': ['zhipu-glm-global', 'zai-coding-plan-global'],
};
export const cases = presets.flatMap(p => {
  const urls = [...new Set(Object.values(p.runtimes).flatMap(rt => rt ? [bindInput(rt.baseUrl)] : []))];
  return [
    { id: `wizard-${p.id}`, kind: 'wizard', providerId: p.id, address: '', expectedIds: [p.id] },
    ...urls.map((address, i) => ({ id: `address-${p.id}-${i}`, kind: 'address', providerId: p.id, address,
      // Expected ambiguity comes from declared catalog addresses, not the matcher under test.
      expectedIds: sharedInterfaceInputs[address] ?? (deployments.includes(p.id) ? [p.id] : presets.filter(other => !deployments.includes(other.id)
        && Object.values(other.runtimes).some(rt => rt && bindInput(rt.baseUrl) === address)).map(other => other.id)),
    })),
  ];
});
