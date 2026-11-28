// The isolated HTTP harness lacks secure-context randomUUID. This identifier is
// only used to distinguish this fixture's renderer; it never leaves the fixture.
if (!crypto.randomUUID) {
  Object.defineProperty(crypto, 'randomUUID', {
    value: () => '00000000-0000-4000-8000-000000000001',
  });
}
