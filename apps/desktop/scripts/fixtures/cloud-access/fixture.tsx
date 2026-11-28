import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { mountPage, forbid } from '../../ui-page/harness';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import {
  CloudInstanceAccessProvider,
  useCloudInstanceAccess,
} from '../../../src/renderer/features/cloud-settings/CloudInstanceAccess';
import { RemoteControlSection } from '../../../src/renderer/components/settings/RemoteControlSection';

export const CLOUD = 'cloud-device-0123456789abcdef01234567';

function Preview() {
  const access = useCloudInstanceAccess();
  return (
    <main data-access={access} className="mx-auto max-w-[920px] p-6">
      {/* A cloud instance is managed on its card in My devices. */}
      <RemoteControlSection />
    </main>
  );
}

mountPage({
  host: (ctx) => {
    const allowed = ctx.data.access === 'allowed';
    const instances = (ctx.data.instances ?? []) as { deviceId: string; policy?: unknown }[];
    // As in Main: the list carries no maintenance policy, the per-instance read does.
    const project = (instance: (typeof instances)[number], maintenance: unknown) => {
      const view: Partial<typeof instance> = { ...instance };
      delete view.policy;
      return { ...view, maintenance };
    };
    return {
      cloudLoginWindow: { open: forbid('cloudLoginWindow.open'), onCompleted: () => () => {} },
      cloudSettings: {
        instanceAccess: async () => {
          if (ctx.data.access === 'hidden') return { schemaVersion: 1, allowed: false };
          if (ctx.data.access === 'checking') return new Promise(() => {});
          return { schemaVersion: 1, allowed: true };
        },
        // Outside the allowlist the device list must not reach CIS at all.
        instanceList: allowed
          ? async () => instances.map((view) => project(view, null))
          : forbid('cloudSettings.instanceList'),
        instanceRead: async ({ deviceId }: { deviceId: string }) => {
          const view = instances.find((item) => item.deviceId === deviceId)!;
          return project(view, view.policy ?? null);
        },
        // The owner's instance limit, when the case gives one.
        instanceCapacity: async () => (ctx.data.capacity as { limit: number; used: number } | undefined) ?? null,
        instanceClaim: forbid('cloudSettings.instanceClaim'),
        // Accepted, not yet listed: the card shows its own request under way (case 'several').
        instancePower: ctx.data.several ? async () => undefined : forbid('cloudSettings.instancePower'),
        instanceUpgrade: forbid('cloudSettings.instanceUpgrade'),
        instancePolicy: forbid('cloudSettings.instancePolicy'),
        instanceInitialize: forbid('cloudSettings.instanceInitialize'),
      },
      openRemoteDesktop: forbid('openRemoteDesktop'),
      remoteSsh: { list: async () => ({ hosts: [] }), onStatusChanged: () => () => {} },
    };
  },
  render: (ctx) => {
    setDataOwnerGeneration('fixture-owner', 1);
    // The device card's draft guard needs a data router, as in the app.
    const router = createMemoryRouter([{ path: '*', element: <Preview /> }], {
      initialEntries: [
        // Without a device: the plain section also exists before this change, for --compare.
        ctx.data.section
          ? `/settings?tab=remote-control&section=${ctx.data.section}`
          : `/settings?tab=remote-control&section=remoteControl.cloudInstances&device=${CLOUD}`,
      ],
    });
    return (
      <CloudInstanceAccessProvider>
        <RouterProvider router={router} />
      </CloudInstanceAccessProvider>
    );
  },
});
