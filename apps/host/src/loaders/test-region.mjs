// Host tests run as the source default edition (global) whatever the machine's shell carries. From
// source the desktop modules' region follows CINDY_HOST_REGION (raw-hook.mjs) and so does
// profile-path.mjs resolveHostRegion; VITE_CINDY_AUTH_REGION is a desktop build variable that some
// shells inherit. A test of another edition passes CINDY_HOST_REGION to its own child process.
// Imported by the test command (package.json "test"); node --test hands it to every test file's process.
delete process.env.CINDY_HOST_REGION;
delete process.env.VITE_CINDY_AUTH_REGION;
