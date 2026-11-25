#define _GNU_SOURCE
#include "cursor.h"
#include "encode.h"
#include "jpeg.h"
#include "wlr-screencopy-unstable-v1.h"
#ifdef CINDY_X11
#include "x11.h"
#endif
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>

/* Private, serial protocol: one 'f' request, one bounded base64 JPEG line.
 * The connection and shm buffer survive requests, but no frame history does.
 * Unsupported output layouts exit so the parent can use grim's composition.
 * An `x11:<x>,<y>,<width>,<height>` output selects root-window capture of that
 * pixel rectangle on an X11 session instead (see x11.h).
 */
struct output_info {
  struct wl_output *output;
  uint32_t id;
  int transform;
  char name[128];
};
struct capture {
  struct wl_display *display;
  struct wl_shm *shm;
  struct wl_output *output;
  struct zwlr_screencopy_manager_v1 *manager;
  struct wl_buffer *buffer;
  uint32_t output_name, outputs, width, height, stride, format;
  int transform, done, failed;
  uint32_t flags;
  void *pixels;
  unsigned char *scaled, *oriented;
  size_t size;
  int overlay, quality, cursor_free, x11;
  struct output_info output_info[32];
  const char *requested_output;
};
static void geometry(void *data, struct wl_output *output, int32_t x, int32_t y,
                     int32_t pw, int32_t ph, int32_t subpixel, const char *make,
                     const char *model, int32_t transform) {
  (void)output;
  (void)x;
  (void)y;
  (void)pw;
  (void)ph;
  (void)subpixel;
  (void)make;
  (void)model;
  ((struct output_info *)data)->transform = transform;
}
static void mode(void *data, struct wl_output *output, uint32_t flags,
                 int32_t width, int32_t height, int32_t refresh) {
  (void)data;
  (void)output;
  (void)flags;
  (void)width;
  (void)height;
  (void)refresh;
}
static void output_done(void *d, struct wl_output *o) {
  (void)d;
  (void)o;
}
static void output_scale(void *d, struct wl_output *o, int32_t s) {
  (void)d;
  (void)o;
  (void)s;
}
static void output_name(void *d, struct wl_output *o, const char *name) {
  (void)o;
  snprintf(((struct output_info *)d)->name, 128, "%s", name);
}
static void output_description(void *d, struct wl_output *o, const char *s) {
  (void)d;
  (void)o;
  (void)s;
}
static const struct wl_output_listener output_listener = {
    .geometry = geometry,
    .mode = mode,
    .done = output_done,
    .scale = output_scale,
    .name = output_name,
    .description = output_description};
static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
  (void)version;
  struct capture *c = data;
  cursor_global(registry, name, interface);
  if (!strcmp(interface, wl_shm_interface.name))
    c->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
  else if (!strcmp(interface, zwlr_screencopy_manager_v1_interface.name))
    c->manager = wl_registry_bind(registry, name,
                                  &zwlr_screencopy_manager_v1_interface, 1);
  else if (!strcmp(interface, wl_output_interface.name)) {
    if (c->outputs >= 32) {
      c->failed = 1;
      return;
    }
    struct output_info *o = &c->output_info[c->outputs++];
    o->id = name;
    o->output = wl_registry_bind(registry, name, &wl_output_interface,
                                 version < 4 ? version : 4);
    wl_output_add_listener(o->output, &output_listener, o);
  }
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) {
  (void)registry;
  struct capture *c = data;
  /* A changed layout requires the parent to obtain fresh display geometry. */
  if (name == c->output_name)
    c->failed = 1;
}
static const struct wl_registry_listener registry_listener = {global, removed};
static void release_buffer(struct capture *c) {
  if (c->buffer)
    wl_buffer_destroy(c->buffer);
  if (c->pixels)
    munmap(c->pixels, c->size);
  c->buffer = NULL;
  c->pixels = NULL;
  c->size = 0;
}
static void frame_buffer(void *data, struct zwlr_screencopy_frame_v1 *frame,
                         uint32_t format, uint32_t width, uint32_t height,
                         uint32_t stride) {
  struct capture *c = data;
  if (!width || !height || width > 8192 || height > 8192 ||
      (uint64_t)width * height > 16777216 || stride < width * 4 ||
      (uint64_t)stride * height > 67108864 ||
      (format != WL_SHM_FORMAT_XRGB8888 && format != WL_SHM_FORMAT_ARGB8888 &&
       format != WL_SHM_FORMAT_XBGR8888 && format != WL_SHM_FORMAT_ABGR8888)) {
    c->failed = 1;
    return;
  }
  if (!c->buffer || c->width != width || c->height != height ||
      c->stride != stride || c->format != format) {
    release_buffer(c);
    size_t size = (size_t)stride * height;
    int fd = memfd_create("cindy-capture", MFD_CLOEXEC);
    if (fd < 0) {
      c->failed = 1;
      return;
    }
    if (ftruncate(fd, (off_t)size)) {
      close(fd);
      c->failed = 1;
      return;
    }
    void *pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (pixels == MAP_FAILED) {
      close(fd);
      c->failed = 1;
      return;
    }
    struct wl_shm_pool *pool = wl_shm_create_pool(c->shm, fd, (int32_t)size);
    c->buffer = wl_shm_pool_create_buffer(
        pool, 0, (int32_t)width, (int32_t)height, (int32_t)stride, format);
    wl_shm_pool_destroy(pool);
    close(fd);
    c->pixels = pixels;
    c->size = size;
    c->width = width;
    c->height = height;
    c->stride = stride;
    c->format = format;
  }
  zwlr_screencopy_frame_v1_copy(frame, c->buffer);
}
static void frame_flags(void *data, struct zwlr_screencopy_frame_v1 *frame,
                        uint32_t flags) {
  (void)frame;
  ((struct capture *)data)->flags = flags;
}
static void frame_ready(void *data, struct zwlr_screencopy_frame_v1 *frame,
                        uint32_t high, uint32_t low, uint32_t ns) {
  (void)frame;
  (void)high;
  (void)low;
  (void)ns;
  ((struct capture *)data)->done = 1;
}
static void frame_failed(void *data, struct zwlr_screencopy_frame_v1 *frame) {
  (void)frame;
  ((struct capture *)data)->failed = 1;
}
static const struct zwlr_screencopy_frame_v1_listener frame_listener = {
    .buffer = frame_buffer,
    .flags = frame_flags,
    .ready = frame_ready,
    .failed = frame_failed};
/* Scaling lives in encode.h, shared with the GNOME capture helper. */
static const unsigned char *video_pixels(struct capture *c, int *width,
                                         int *height, int *stride) {
  return cindy_scale_pixels(c->pixels, c->width, c->height, c->stride,
                            &c->scaled, width, height, stride);
}
/* Screencopy buffers use output-buffer coordinates. Rotate into the displayed
 * orientation after bounded scaling, applying Y_INVERT in buffer coordinates.
 * Keep the normal output's zero-copy path and reuse at most one extra buffer. */
static const unsigned char *oriented_pixels(struct capture *c, int *width,
                                            int *height, int *stride) {
  const unsigned char *source = video_pixels(c, width, height, stride);
  if (!source || c->transform == WL_OUTPUT_TRANSFORM_NORMAL)
    return source;
  if (c->transform < 0 || c->transform > WL_OUTPUT_TRANSFORM_FLIPPED_270)
    return NULL;
  int sw = *width, sh = *height, ss = *stride;
  int rotation = c->transform & 3;
  if (rotation & 1) {
    *width = sh;
    *height = sw;
  }
  *stride = *width * 4;
  if (!c->oriented)
    c->oriented = malloc(1920 * 1920 * 4);
  if (!c->oriented)
    return NULL;
  for (int y = 0; y < sh; y++) {
    int sy = c->flags & ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT ? sh - 1 - y : y;
    for (int x = 0; x < sw; x++) {
      int dx = x, dy = y;
      switch (rotation) {
      case 1: dx = sh - 1 - y; dy = x; break;
      case 2: dx = sw - 1 - x; dy = sh - 1 - y; break;
      case 3: dx = y; dy = sw - 1 - x; break;
      }
      if (c->transform & WL_OUTPUT_TRANSFORM_FLIPPED)
        dx = *width - 1 - dx;
      memcpy(c->oriented + dy * *stride + dx * 4, source + sy * ss + x * 4, 4);
    }
  }
  return c->oriented;
}
static int send_jpeg(struct capture *c) {
  unsigned char *jpeg = NULL;
  unsigned long length = 0;
  int bgrx = c->format == WL_SHM_FORMAT_XRGB8888 ||
             c->format == WL_SHM_FORMAT_ARGB8888;
  int bottom_up = c->transform == WL_OUTPUT_TRANSFORM_NORMAL &&
                  (c->flags & ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT);
  int width, height, stride;
  const unsigned char *pixels = oriented_pixels(c, &width, &height, &stride);
  if (!pixels)
    return -1;
  int status = -1;
  for (int quality = c->quality ? c->quality : 65; quality >= 25;
       quality -= 20) {
    jpeg_release(jpeg);
    if (jpeg_encode(pixels, width, stride, height, bgrx, bottom_up, quality,
                    &jpeg, &length))
      goto done;
    if (length <= 1000000)
      break;
  }
  if (!length || length > 1000000)
    goto done;
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t count = 4 * ((length + 2) / 3);
  char *line = malloc(count + 1);
  if (!line)
    goto done;
  for (size_t i = 0, j = 0; i < length; i += 3) {
    uint32_t value = (uint32_t)jpeg[i] << 16;
    if (i + 1 < length)
      value |= (uint32_t)jpeg[i + 1] << 8;
    if (i + 2 < length)
      value |= jpeg[i + 2];
    line[j++] = alphabet[value >> 18];
    line[j++] = alphabet[(value >> 12) & 63];
    line[j++] = i + 1 < length ? alphabet[(value >> 6) & 63] : '=';
    line[j++] = i + 2 < length ? alphabet[value & 63] : '=';
  }
  line[count] = 0;
  if (c->overlay) {
    printf("{\"jpeg\":\"%s\",\"cursor\":", line);
#ifdef CINDY_X11
    if (c->x11)
      x11_cursor_json();
    else
#endif
        if (c->cursor_free)
      cursor_json(c->width, c->height);
    else
      fputs("null", stdout);
    fputs("}\n", stdout);
  } else {
    fwrite(line, 1, count, stdout);
    fputc('\n', stdout);
  }
  status = ferror(stdout) || fflush(stdout) ? -1 : 0;
  free(line);
done:
  jpeg_release(jpeg);
  return status;
}
#ifdef CINDY_X11
/* Same serial request loop as the Wayland path, over the X root window. */
static int x11_main(struct capture *c) {
  int status = 1;
  if (x11_open(c->requested_output + 4) || jpeg_open())
    goto done;
  xc.scale = cc.scale;
  c->x11 = 1;
  c->transform = WL_OUTPUT_TRANSFORM_NORMAL;
  c->format = xc.bgrx ? WL_SHM_FORMAT_XRGB8888 : WL_SHM_FORMAT_XBGR8888;
  for (;;) {
    alarm(10);
    char command;
    ssize_t n = read(STDIN_FILENO, &command, 1);
    if (!n) {
      status = 0;
      break;
    }
    if (n != 1 || command != 'f')
      break;
    alarm(3);
    if (x11_frame())
      break;
    if (c->overlay)
      x11_cursor();
    c->pixels = xc.image->data;
    c->width = (uint32_t)xc.width;
    c->height = (uint32_t)xc.height;
    c->stride = (uint32_t)xc.image->bytes_per_line;
    if (send_jpeg(c))
      break;
  }
done:
  /* The X image owns its pixels; never munmap them as a Wayland buffer. */
  c->pixels = NULL;
  free(c->scaled);
  x11_close();
  jpeg_close();
  return status;
}
#endif
int main(int argc, char **argv) {
  if (argc != 1 && argc != 4 && argc != 5 && argc != 2)
    return 2;
  struct capture c = {0};
  if (argc == 2 && !strcmp(argv[1], "--x11-check")) {
#ifdef CINDY_X11
    /* Probe only: no image, cursor read or frame. */
    alarm(3);
    int ready = !x11_open(NULL) && !jpeg_open();
    x11_close();
    jpeg_close();
    if (ready)
      puts("ready");
    return ready ? 0 : 1;
#else
    return 1; /* Built without X11 development headers. */
#endif
  }
  int probe = argc == 2 && !strcmp(argv[1], "--cursor-check");
  if (argc == 2 && !probe)
    return 2;
  if (argc == 4 || argc == 5) {
    c.overlay = !strcmp(argv[1], "cursor-overlay");
    if (!c.overlay && strcmp(argv[1], "video"))
      return 2;
    cc.scale = strtod(argv[2], NULL);
    c.quality = atoi(argv[3]);
    if (!isfinite(cc.scale) || cc.scale < 0.25 || cc.scale > 8 ||
        c.quality < 25 || c.quality > 95)
      return 2;
    if (argc == 5)
      c.requested_output = argv[4];
  }
  if (c.requested_output && !strncmp(c.requested_output, "x11:", 4)) {
#ifdef CINDY_X11
    alarm(3);
    return x11_main(&c);
#else
    return 1;
#endif
  }
  /* Bound compositor stalls, blocked writes and orphaned idle children. No
   * files survive a signal exit: memfd and Wayland objects belong to this
   * process. */
  alarm(3);
  c.display = wl_display_connect(NULL);
  if (!c.display)
    return 1;
  struct wl_registry *registry = wl_display_get_registry(c.display);
  wl_registry_add_listener(registry, &registry_listener, &c);
  int status = 1;
  if (wl_display_roundtrip(c.display) < 0 ||
      wl_display_roundtrip(c.display) < 0 || !c.shm || !c.manager || c.failed)
    goto done;
  if (probe) {
    status = cc.manager && cc.sources && cc.seat ? 0 : 1;
    if (!status)
      puts("ready");
    goto done;
  }
  for (uint32_t i = 0; i < c.outputs; i++) {
    struct output_info *o = &c.output_info[i];
    if ((c.requested_output && !strcmp(o->name, c.requested_output)) ||
        (!c.requested_output && c.outputs == 1)) {
      c.output = o->output;
      c.output_name = o->id;
      c.transform = o->transform;
      break;
    }
  }
  if (!c.output)
    goto done;
  if (c.overlay && cursor_begin(c.shm, c.output))
    goto done;
  if (jpeg_open())
    goto done;
  for (;;) {
    alarm(10);
    char command;
    ssize_t n = read(STDIN_FILENO, &command, 1);
    if (!n) {
      status = 0;
      break;
    }
    if (n != 1 || command != 'f')
      break;
    alarm(3);
    c.done = 0;
    c.flags = 0;
    if (c.failed)
      break;
    /* Hyprland 0.56 can return a transparent image for compositor-owned
     * cursors. Keep the baked OS cursor until a real image is available. */
    c.cursor_free = c.overlay && cc.has_image && !cc.failed &&
                    c.transform == WL_OUTPUT_TRANSFORM_NORMAL;
    struct zwlr_screencopy_frame_v1 *frame =
        zwlr_screencopy_manager_v1_capture_output(c.manager, !c.cursor_free,
                                                  c.output);
    zwlr_screencopy_frame_v1_add_listener(frame, &frame_listener, &c);
    while (!c.done && !c.failed) {
      if (wl_display_dispatch(c.display) < 0) {
        c.failed = 1;
        break;
      }
    }
    zwlr_screencopy_frame_v1_destroy(frame);
    for (uint32_t i = 0; i < c.outputs; i++)
      if (c.output_info[i].id == c.output_name &&
          c.output_info[i].transform != c.transform)
        c.failed = 1; // Layout changed during this capture; obtain fresh geometry.
    if (c.failed || send_jpeg(&c))
      break;
  }
done:
  cursor_destroy();
  jpeg_close();
  release_buffer(&c);
  free(c.scaled);
  free(c.oriented);
  for (uint32_t i = 0; i < c.outputs; i++)
    wl_output_destroy(c.output_info[i].output);
  if (c.manager)
    zwlr_screencopy_manager_v1_destroy(c.manager);
  if (c.shm)
    wl_shm_destroy(c.shm);
  wl_registry_destroy(registry);
  wl_display_disconnect(c.display);
  return status;
}
