import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Synthetic pixels only: no compositor connection, screenshot or input event.
test('native capture bounds buffers and scales padded rows without distortion', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-capture-test-'));
  const source = path.dirname(fileURLToPath(import.meta.url));
  function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  }
  try {
    run(process.execPath, [path.join(source, 'build.mjs'), output]);
    // Including the implementation exercises actual pixel/bounds code while
    // leaving its normal main (and all Wayland calls) unexecuted.
    const testSource = path.join(output, 'test.c');
    fs.writeFileSync(
      testSource,
      `
#define main capture_entry
#include ${JSON.stringify(path.join(source, 'main.c'))}
#undef main
#include <assert.h>
int main(void) {
  uint32_t invalid[][4] = {
    {WL_SHM_FORMAT_XRGB8888,0,10,40},
    {WL_SHM_FORMAT_XRGB8888,100,100,399},
    {WL_SHM_FORMAT_XRGB8888,8193,1,32772},
    {WL_SHM_FORMAT_XRGB8888,8192,8192,32768},
    {WL_SHM_FORMAT_XRGB8888,100,100,UINT32_MAX},
    {WL_SHM_FORMAT_RGB565,100,100,400}
  };
  for (unsigned i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++) {
    struct capture c={0};
    frame_buffer(&c,NULL,invalid[i][0],invalid[i][1],invalid[i][2],invalid[i][3]);
    assert(c.failed && !c.buffer && !c.pixels);
  }
  struct capture c={.width=2560,.height=1600,.stride=2560*4+32};
  c.pixels=calloc(c.height,c.stride); assert(c.pixels);
  for (uint32_t y=0;y<c.height;y++) for(uint32_t x=0;x<c.width;x++) {
    unsigned char *p=(unsigned char*)c.pixels+y*c.stride+x*4;
    p[0]=(unsigned char)(x*255/(c.width-1)); p[1]=(unsigned char)(y*255/(c.height-1)); p[2]=42;
  }
  int w,h,stride; const unsigned char *p=video_pixels(&c,&w,&h,&stride);
  assert(p && w==1920 && h==1200 && stride==7680);
  assert(p[0]==0 && p[1]==0 && p[2]==42);
  size_t last=(size_t)(h-1)*stride+(w-1)*4;
  assert(p[last]==255 && p[last+1]==255 && p[last+2]==42);
  assert(video_pixels(&c,&w,&h,&stride)==p);
  c.width=100;c.height=50;c.stride=432;
  assert(video_pixels(&c,&w,&h,&stride)==c.pixels && w==100 && h==50 && stride==432);
  free(c.pixels);free(c.scaled);
  // A non-square, padded raster detects swapped axes, wrong rotation order and
  // reading padding as pixels. Expectations are in displayed row-major order.
  const unsigned char expected[8][6] = {
    {1,2,3,4,5,6}, {4,1,5,2,6,3}, {6,5,4,3,2,1}, {3,6,2,5,1,4},
    {3,2,1,6,5,4}, {1,4,2,5,3,6}, {4,5,6,1,2,3}, {6,3,5,2,4,1}
  };
  for(int invert=0;invert<2;invert++) for(int transform=0;transform<8;transform++) {
    struct capture r={.width=3,.height=2,.stride=16,.transform=transform,
      .flags=invert ? ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT : 0};
    unsigned char raster[32]={0}; r.pixels=raster;
    for(int y=0;y<2;y++) for(int x=0;x<3;x++)
      raster[(invert ? 1-y : y)*16+x*4]=(unsigned char)(y*3+x+1);
    p=oriented_pixels(&r,&w,&h,&stride);
    assert(p && w==(transform%2 ? 2 : 3) && h==(transform%2 ? 3 : 2));
    for(int y=0;y<h;y++) for(int x=0;x<w;x++) {
      // The zero-copy path deliberately leaves normal Y_INVERT to TurboJPEG.
      int py=transform==0 && invert ? h-1-y : y;
      assert(p[py*stride+x*4]==expected[transform][y*w+x]);
    }
    assert(oriented_pixels(&r,&w,&h,&stride)==p);
    free(r.oriented);
  }
  // Hyprland's cursor position is logical even when video is physical pixels.
  cc.png="AA==";cc.visible=1;cc.allocated_width=32;cc.allocated_height=32;
  cc.scale=1;cc.x=1280;cc.y=800;cursor_json(2560,1600);puts("");
  cc.scale=1.6;cc.x=800;cc.y=500;cursor_json(2560,1600);puts("");
  cc.x=-20;cc.y=2000;cursor_json(2560,1600);puts("");
  return 0;
}
`,
    );
    const flags = run('pkg-config', [
      '--cflags',
      '--libs',
      'wayland-client',
      'libturbojpeg',
      'libpng',
    ]).split(/\s+/);
    run('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-O2',
      '-fsanitize=address,undefined',
      testSource,
      ...[
        'wlr-screencopy-unstable-v1',
        'ext-image-copy-capture-v1',
        'ext-image-capture-source-v1',
        'ext-foreign-toplevel-list-v1',
      ].map((name) => path.join(output, name + '.c')),
      '-I',
      output,
      ...flags,
      '-o',
      path.join(output, 'test'),
    ]);
    const cursors = run(path.join(output, 'test'), [])
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      cursors.map(({ x, y }) => [x, y]),
      [
        [0.5, 0.5],
        [0.5, 0.5],
        [0, 1],
      ],
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
