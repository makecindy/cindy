import { getCACertificates, setDefaultCACertificates } from 'node:tls';

// Packaged builds disable the EnableNodeOptionsEnvironmentVariable fuse, which also
// makes Node ignore NODE_EXTRA_CA_CERTS. Chromium (net.fetch, renderer) already trusts
// the OS certificate store; give the main-process Node stack (ws, undici, https) the
// same trust so TLS-inspecting gateways whose root CA is installed by the OS or the
// organization (e.g. Cisco Umbrella) do not fail with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
// Must run before any outbound TLS connection is created.
setDefaultCACertificates([...new Set([...getCACertificates('default'), ...getCACertificates('system')])]);
