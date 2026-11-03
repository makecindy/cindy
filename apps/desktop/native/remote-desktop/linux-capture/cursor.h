/* Cursor images and hotspot updates share the video child's Wayland connection.
 * A pending cursor frame waits for damage without blocking desktop frames. */
#include "ext-image-capture-source-v1.h"
#include "ext-image-copy-capture-v1.h"
#include <math.h>
#include <png.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

struct cursor_capture {
  struct wl_seat *seat;
  struct wl_pointer *pointer;
  struct ext_image_copy_capture_manager_v1 *manager;
  struct ext_output_image_capture_source_manager_v1 *sources;
  struct ext_image_capture_source_v1 *source;
  struct ext_image_copy_capture_cursor_session_v1 *cursor;
  struct ext_image_copy_capture_session_v1 *session;
  struct ext_image_copy_capture_frame_v1 *frame;
  struct wl_shm *shm;
  struct wl_buffer *buffer;
  void *pixels;
  size_t size;
  uint32_t width, height, allocated_width, allocated_height, format, transform;
  int visible, failed, constraints, batch, has_image, x, y, hot_x, hot_y,
      pending_hot_x, pending_hot_y;
  char *png;
  double scale;
};
static struct cursor_capture cc;
static char *base64(const unsigned char *bytes, size_t length) {
  static const char abc[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  char *out = malloc(4 * ((length + 2) / 3) + 1);
  if (!out)
    return NULL;
  size_t j = 0;
  for (size_t i = 0; i < length; i += 3) {
    uint32_t n = (uint32_t)bytes[i] << 16;
    if (i + 1 < length)
      n |= (uint32_t)bytes[i + 1] << 8;
    if (i + 2 < length)
      n |= bytes[i + 2];
    out[j++] = abc[n >> 18];
    out[j++] = abc[(n >> 12) & 63];
    out[j++] = i + 1 < length ? abc[(n >> 6) & 63] : '=';
    out[j++] = i + 2 < length ? abc[n & 63] : '=';
  }
  out[j] = 0;
  return out;
}
static void cursor_request(void);
static void cursor_transform(void *d, struct ext_image_copy_capture_frame_v1 *f,
                             uint32_t t) {
  (void)d;
  (void)f;
  cc.transform = t;
}
static void cursor_damage(void *d, struct ext_image_copy_capture_frame_v1 *f,
                          int32_t x, int32_t y, int32_t w, int32_t h) {
  (void)d;
  (void)f;
  (void)x;
  (void)y;
  (void)w;
  (void)h;
}
static void cursor_time(void *d, struct ext_image_copy_capture_frame_v1 *f,
                        uint32_t a, uint32_t b, uint32_t c) {
  (void)d;
  (void)f;
  (void)a;
  (void)b;
  (void)c;
}
static void cursor_ready(void *d, struct ext_image_copy_capture_frame_v1 *f) {
  (void)d;
  ext_image_copy_capture_frame_v1_destroy(f);
  cc.frame = NULL;
  if (cc.transform != WL_OUTPUT_TRANSFORM_NORMAL) {
    cc.failed = 1;
    return;
  }
  png_image image = {.version = PNG_IMAGE_VERSION,
                     .width = cc.allocated_width,
                     .height = cc.allocated_height,
                     .format = PNG_FORMAT_RGBA};
  size_t count = (size_t)cc.allocated_width * cc.allocated_height;
  unsigned char *rgba = malloc(count * 4);
  if (!rgba) {
    cc.failed = 1;
    return;
  }
  /* Wayland ARGB is native-endian and premultiplied; PNG is straight RGBA. */
  cc.has_image = 0;
  for (size_t i = 0; i < count; i++) {
    uint32_t p = ((uint32_t *)cc.pixels)[i], a = p >> 24;
    if (a)
      cc.has_image = 1;
    rgba[i * 4 + 3] = (unsigned char)a;
    for (unsigned k = 0; k < 3; k++) {
      unsigned v = (p >> (16 - 8 * k)) & 255;
      rgba[i * 4 + k] =
          (unsigned char)(a ? fmin(255, (v * 255 + a / 2) / a) : 0);
    }
  }
  png_alloc_size_t size = 0;
  if (!png_image_write_to_memory(&image, NULL, &size, 0, rgba, 0, NULL) ||
      size > 49152)
    cc.failed = 1;
  else {
    unsigned char *png = malloc(size);
    if (!png ||
        !png_image_write_to_memory(&image, png, &size, 0, rgba, 0, NULL))
      cc.failed = 1;
    else {
      free(cc.png);
      cc.png = base64(png, size);
      cc.hot_x = cc.pending_hot_x;
      cc.hot_y = cc.pending_hot_y;
      if (!cc.png)
        cc.failed = 1;
    }
    free(png);
  }
  free(rgba);
  png_image_free(&image);
  cursor_request();
}
static void cursor_failed(void *d, struct ext_image_copy_capture_frame_v1 *f,
                          uint32_t reason) {
  (void)d;
  ext_image_copy_capture_frame_v1_destroy(f);
  cc.frame = NULL;
  if (reason !=
      EXT_IMAGE_COPY_CAPTURE_FRAME_V1_FAILURE_REASON_BUFFER_CONSTRAINTS)
    cc.failed = 1;
  cursor_request();
}
static const struct ext_image_copy_capture_frame_v1_listener
    cursor_frame_listener = {.transform = cursor_transform,
                             .damage = cursor_damage,
                             .presentation_time = cursor_time,
                             .ready = cursor_ready,
                             .failed = cursor_failed};
static void cursor_request(void) {
  if (cc.failed || cc.frame || !cc.constraints)
    return;
  if (!cc.width || !cc.height || cc.width > 256 || cc.height > 256 ||
      cc.format != WL_SHM_FORMAT_ARGB8888) {
    cc.failed = 1;
    return;
  }
  if (!cc.buffer || cc.allocated_width != cc.width ||
      cc.allocated_height != cc.height) {
    if (cc.buffer)
      wl_buffer_destroy(cc.buffer);
    if (cc.pixels)
      munmap(cc.pixels, cc.size);
    cc.buffer = NULL;
    cc.pixels = NULL;
    cc.size = (size_t)cc.width * cc.height * 4;
    int fd = memfd_create("cindy-cursor", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, (off_t)cc.size) < 0) {
      if (fd >= 0)
        close(fd);
      cc.failed = 1;
      return;
    }
    cc.pixels = mmap(NULL, cc.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (cc.pixels == MAP_FAILED) {
      cc.pixels = NULL;
      close(fd);
      cc.failed = 1;
      return;
    }
    struct wl_shm_pool *pool = wl_shm_create_pool(cc.shm, fd, (int32_t)cc.size);
    cc.buffer = wl_shm_pool_create_buffer(pool, 0, (int32_t)cc.width,
                                          (int32_t)cc.height,
                                          (int32_t)cc.width * 4, cc.format);
    wl_shm_pool_destroy(pool);
    close(fd);
    cc.allocated_width = cc.width;
    cc.allocated_height = cc.height;
  }
  cc.frame = ext_image_copy_capture_session_v1_create_frame(cc.session);
  ext_image_copy_capture_frame_v1_add_listener(cc.frame, &cursor_frame_listener,
                                               NULL);
  ext_image_copy_capture_frame_v1_attach_buffer(cc.frame, cc.buffer);
  ext_image_copy_capture_frame_v1_damage_buffer(
      cc.frame, 0, 0, (int32_t)cc.width, (int32_t)cc.height);
  ext_image_copy_capture_frame_v1_capture(cc.frame);
}
static void cursor_constraints(void) {
  if (!cc.batch) {
    cc.batch = 1;
    cc.constraints = 0;
    cc.format = UINT32_MAX;
  }
}
static void cursor_size(void *d, struct ext_image_copy_capture_session_v1 *s,
                        uint32_t w, uint32_t h) {
  (void)d;
  (void)s;
  cursor_constraints();
  cc.width = w;
  cc.height = h;
}
static void cursor_format(void *d, struct ext_image_copy_capture_session_v1 *s,
                          uint32_t f) {
  (void)d;
  (void)s;
  cursor_constraints();
  if (f == WL_SHM_FORMAT_ARGB8888)
    cc.format = f;
}
static void cursor_device(void *d, struct ext_image_copy_capture_session_v1 *s,
                          struct wl_array *a) {
  (void)d;
  (void)s;
  (void)a;
}
static void cursor_dmabuf(void *d, struct ext_image_copy_capture_session_v1 *s,
                          uint32_t f, struct wl_array *a) {
  (void)d;
  (void)s;
  (void)f;
  (void)a;
}
static void cursor_done(void *d, struct ext_image_copy_capture_session_v1 *s) {
  (void)d;
  (void)s;
  cc.constraints = 1;
  cc.batch = 0;
  cursor_request();
}
static void cursor_stopped(void *d,
                           struct ext_image_copy_capture_session_v1 *s) {
  (void)d;
  (void)s;
  cc.failed = 1;
}
static const struct ext_image_copy_capture_session_v1_listener
    cursor_session_listener = {.buffer_size = cursor_size,
                               .shm_format = cursor_format,
                               .dmabuf_device = cursor_device,
                               .dmabuf_format = cursor_dmabuf,
                               .done = cursor_done,
                               .stopped = cursor_stopped};
static void cursor_enter(void *d,
                         struct ext_image_copy_capture_cursor_session_v1 *s) {
  (void)d;
  (void)s;
  cc.visible = 1;
}
static void cursor_leave(void *d,
                         struct ext_image_copy_capture_cursor_session_v1 *s) {
  (void)d;
  (void)s;
  cc.visible = 0;
}
static void cursor_position(void *d,
                            struct ext_image_copy_capture_cursor_session_v1 *s,
                            int32_t x, int32_t y) {
  (void)d;
  (void)s;
  cc.x = x;
  cc.y = y;
}
static void cursor_hotspot(void *d,
                           struct ext_image_copy_capture_cursor_session_v1 *s,
                           int32_t x, int32_t y) {
  (void)d;
  (void)s;
  cc.pending_hot_x = x;
  cc.pending_hot_y = y;
}
static const struct ext_image_copy_capture_cursor_session_v1_listener
    cursor_listener = {.enter = cursor_enter,
                       .leave = cursor_leave,
                       .position = cursor_position,
                       .hotspot = cursor_hotspot};
static void cursor_global(struct wl_registry *registry, uint32_t name,
                          const char *interface) {
  if (!strcmp(interface, wl_seat_interface.name) && !cc.seat)
    cc.seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  if (!strcmp(interface, ext_image_copy_capture_manager_v1_interface.name))
    cc.manager = wl_registry_bind(
        registry, name, &ext_image_copy_capture_manager_v1_interface, 1);
  if (!strcmp(interface,
              ext_output_image_capture_source_manager_v1_interface.name))
    cc.sources = wl_registry_bind(
        registry, name, &ext_output_image_capture_source_manager_v1_interface,
        1);
}
static int cursor_begin(struct wl_shm *shm, struct wl_output *output) {
  if (!cc.manager || !cc.sources || !cc.seat)
    return -1;
  cc.shm = shm;
  cc.pointer = wl_seat_get_pointer(cc.seat);
  cc.source = ext_output_image_capture_source_manager_v1_create_source(
      cc.sources, output);
  cc.cursor = ext_image_copy_capture_manager_v1_create_pointer_cursor_session(
      cc.manager, cc.source, cc.pointer);
  ext_image_copy_capture_cursor_session_v1_add_listener(cc.cursor,
                                                        &cursor_listener, NULL);
  cc.session =
      ext_image_copy_capture_cursor_session_v1_get_capture_session(cc.cursor);
  ext_image_copy_capture_session_v1_add_listener(
      cc.session, &cursor_session_listener, NULL);
  return 0;
}
static void cursor_json(uint32_t width, uint32_t height) {
  if (!cc.png || cc.failed) {
    fputs("null", stdout);
    return;
  }
  double scale = cc.scale > 0 ? cc.scale : 1;
  printf("{\"visible\":%s,\"x\":%.6f,\"y\":%.6f,\"width\":%.3f,\"height\":%.3f,"
         "\"hotX\":%.3f,\"hotY\":%.3f,\"png\":\"%s\"}",
         /* Hyprland 0.56 exports positions in source logical coordinates. */
         cc.visible ? "true" : "false", fmax(0, fmin(1, cc.x * scale / width)),
         fmax(0, fmin(1, cc.y * scale / height)), cc.allocated_width / scale,
         cc.allocated_height / scale,
         fmax(0, fmin(cc.allocated_width, cc.hot_x)) / scale,
         fmax(0, fmin(cc.allocated_height, cc.hot_y)) / scale, cc.png);
}
static void cursor_destroy(void) {
  if (cc.frame)
    ext_image_copy_capture_frame_v1_destroy(cc.frame);
  if (cc.session)
    ext_image_copy_capture_session_v1_destroy(cc.session);
  if (cc.cursor)
    ext_image_copy_capture_cursor_session_v1_destroy(cc.cursor);
  if (cc.source)
    ext_image_capture_source_v1_destroy(cc.source);
  if (cc.buffer)
    wl_buffer_destroy(cc.buffer);
  if (cc.pointer)
    wl_pointer_destroy(cc.pointer);
  if (cc.seat)
    wl_seat_destroy(cc.seat);
  if (cc.sources)
    ext_output_image_capture_source_manager_v1_destroy(cc.sources);
  if (cc.manager)
    ext_image_copy_capture_manager_v1_destroy(cc.manager);
  if (cc.pixels)
    munmap(cc.pixels, cc.size);
  free(cc.png);
  memset(&cc, 0, sizeof(cc));
}
