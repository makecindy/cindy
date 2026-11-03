import { Redirect } from 'expo-router';

/** Compatibility for saved links to the retired mobile automation manager. */
export default function LegacyAutomationsRedirect() {
  return <Redirect href="/devices" />;
}
