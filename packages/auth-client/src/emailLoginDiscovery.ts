import { AuthApiError } from "./client.js";
import { isValidEmail } from "./email.js";
import {
  ssoOrgDiscoveryToMethods,
  type AuthMembership,
  type AuthRegion,
  type LoginMethod,
  type SsoOrgDiscovery,
} from "./types.js";

/** Email login shares enterprise realm discovery; personal codes stay in the build region. */
export async function discoverEmailLogin(
  value: string,
  options: {
    buildRegion: AuthRegion;
    discoverOrganization: (domain: string) => Promise<SsoOrgDiscovery>;
    discoverPersonal: (email: string) => Promise<LoginMethod[]>;
  },
): Promise<{ email: string; region: AuthRegion; methods: LoginMethod[] }> {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !isValidEmail(email)) {
    throw new AuthApiError("INVALID_PARAMS", 400, "Invalid email address");
  }
  let organization: SsoOrgDiscovery | null = null;
  try {
    // Only send the domain to the peer region, never the full email address.
    organization = await options.discoverOrganization(
      email.slice(email.indexOf("@") + 1),
    );
  } catch (error) {
    // Ambiguous/unavailable regions must not be treated as a confirmed absence.
    if (!(error instanceof AuthApiError) || error.code !== "ORG_SSO_NOT_FOUND")
      throw error;
  }
  if (organization && organization.region !== options.buildRegion) {
    return {
      email,
      region: organization.region,
      methods: [
        ...ssoOrgDiscoveryToMethods(organization),
        { type: "email_code" },
      ],
    };
  }
  return {
    email,
    region: options.buildRegion,
    // Preserve the existing same-region login methods and SSO preference.
    methods: await options.discoverPersonal(email),
  };
}

/** A successful personal login may offer SSO; discovery failure cannot undo that login. */
export async function discoverPersonalLoginOrganization(
  membership: AuthMembership,
  options: {
    handledEmail: string | null;
    discoverOrganization: (domain: string) => Promise<SsoOrgDiscovery>;
  },
): Promise<SsoOrgDiscovery | null> {
  const email = membership.email?.trim().toLowerCase();
  if (
    membership.kind !== "personal" || !email || email.length > 254 ||
    !isValidEmail(email) || email === options.handledEmail
  ) return null;
  try {
    return await options.discoverOrganization(email.slice(email.indexOf("@") + 1));
  } catch {
    // A hint is optional. Never guess a region from a partial/ambiguous result,
    // and never discard tokens the original region has already issued.
    return null;
  }
}
