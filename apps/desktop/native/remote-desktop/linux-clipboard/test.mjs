import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
test('clipboard parser bounds formats and binary data without a compositor', () => {
  const source = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-clipboard-test-'));
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  };
  try {
    run(process.execPath, [path.join(source, 'build.mjs'), dir]);
    const target = path.join(dir, 'test.c');
    fs.writeFileSync(
      target,
      `
#include "wlr-data-control-unstable-v1.h"
#include <assert.h>
struct fake_offer { int destroyed; const struct zwlr_data_control_offer_v1_listener *listener; };
static void destroy_offer(struct zwlr_data_control_offer_v1 *offer) {
  struct fake_offer *fake=(struct fake_offer *)offer;
  assert(!fake->destroyed); fake->destroyed=1;
}
static int listen_offer(struct zwlr_data_control_offer_v1 *offer, const struct zwlr_data_control_offer_v1_listener *listener, void *data) {
  (void)data; ((struct fake_offer *)offer)->listener=listener; return 0;
}
#define zwlr_data_control_offer_v1_destroy destroy_offer
#define zwlr_data_control_offer_v1_add_listener listen_offer
#define main clipboard_main
#include ${JSON.stringify(path.join(source, 'main.c'))}
#undef main
#include <assert.h>
int main(void) {
  for (int primary=0;primary<2;primary++) {
    struct fake_offer fake={0};
    struct zwlr_data_control_offer_v1 *o=(struct zwlr_data_control_offer_v1 *)&fake;
    device_listener.data_offer(NULL,NULL,o);
    assert(!fake.destroyed && fake.listener);
    fake.listener->offer(NULL,o,"text/plain");
    fake.listener->offer(NULL,o,"text/html");
    assert(!fake.destroyed);
    if (primary) device_listener.primary_selection(NULL,NULL,o);
    else device_listener.selection(NULL,NULL,o);
    assert(fake.destroyed);
  }
  device_listener.selection(NULL,NULL,NULL);
  device_listener.primary_selection(NULL,NULL,NULL);
  unsigned char *bytes=NULL;size_t length=0;
  assert(!decode("YQ==",4,&bytes,&length) && length==1 && bytes[0]=='a');free(bytes);
  assert(decode("Y!==",4,&bytes,&length)==-1);
  assert(decode("A",1,&bytes,&length)==-1);
  assert(decode("====",4,&bytes,&length)==-1);
  assert(payload("{\\\"text\\\":3}")==-1);
  assert(payload("{}")==-1);
  assert(!payload("{\\\"text\\\":\\\"test\\\",\\\"html\\\":\\\"<b>test</b>\\\",\\\"png\\\":\\\"YQ==\\\"}"));
  assert(items[0].length==4 && items[1].length==11 && items[3].length==1);
  for(unsigned i=0;i<4;i++) free(items[i].bytes);
  return 0;
}
`,
    );
    const flags = run('pkg-config', ['--cflags', '--libs', 'wayland-client', 'json-c']).split(
      /\s+/,
    );
    run('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-fsanitize=address,undefined',
      target,
      path.join(dir, 'wlr-data-control-unstable-v1.c'),
      '-I',
      dir,
      ...flags,
      '-o',
      path.join(dir, 'test'),
    ]);
    run(path.join(dir, 'test'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
