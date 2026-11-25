import { lazy } from 'react';
import { CloudSettingsView } from './CloudSettingsView';

const CloudPluginManagement = lazy(() =>
  import('./CloudPluginManagement').then((module) => ({ default: module.CloudPluginManagement })),
);

/** The cloud settings page as a route the router loads on first visit; its plugin pages load on first use. */
export function CloudSettingsRoute() {
  return <CloudSettingsView plugins={CloudPluginManagement} />;
}
