/* GNOME Shell (Mutter) Wayland capture without the portal picker.
 *
 * Mutter's own org.gnome.Mutter.ScreenCast API records one monitor into a
 * PipeWire stream in the logged-in user's session; GNOME shows its usual
 * screen-sharing indicator while it runs. The cursor travels as PipeWire
 * metadata instead of pixels, so the video is cursor-free. Wayland never
 * exposes cursor names: the shape hint comes from matching the cursor raster
 * against the user's configured cursor theme.
 *
 * Same private, serial protocol as cindy-linux-desktop-capture: one 'f'
 * request, one bounded line (base64 JPEG, or a JSON frame with the cursor).
 * The latest frame is kept in memory only; no files, sockets or history.
 *
 *   --check            interfaces present, PipeWire and JPEG usable; no session
 *   --monitors         JSON list of logical monitors (connector, geometry)
 *   video|cursor-overlay <scale> <quality> gnome:<connector>
 */
#define _GNU_SOURCE
#include "cursor_shape.h"
#include "encode.h"
#include "jpeg.h"
#include <gio/gio.h>
#include <math.h>
#include <pipewire/pipewire.h>
#include <poll.h>
#include <signal.h>
#include <spa/buffer/meta.h>
#include <spa/param/video/format-utils.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
/* Last: Xlib's macros (Status, Bool, None) must not reach GLib or SPA. */
#include <X11/Xcursor/Xcursor.h>

#define SCREEN_CAST "org.gnome.Mutter.ScreenCast"
#define SCREEN_CAST_PATH "/org/gnome/Mutter/ScreenCast"
#define SCREEN_CAST_SESSION "org.gnome.Mutter.ScreenCast.Session"
#define CURSOR_META_SIZE(w, h)                                                 \
  (sizeof(struct spa_meta_cursor) + sizeof(struct spa_meta_bitmap) +           \
   (size_t)(w) * (h) * 4)

static GDBusConnection *bus;
static struct {
  char *session;
  guint node;
  int closed, failed, overlay, quality, bgrx;
  double scale;
  struct pw_loop *loop;
  struct pw_context *context;
  struct pw_core *core;
  struct pw_stream *stream;
  struct spa_hook stream_listener, core_listener;
  uint32_t width, height;
  /* The latest complete frame, tightly packed. */
  unsigned char *frame, *scaled;
  size_t frame_size;
  unsigned long frame_serial, encoded_serial;
  char *line;
  /* Latest cursor state from stream metadata. */
  int cursor_known, cursor_visible, cursor_opaque, cursor_x, cursor_y,
      cursor_width, cursor_height, hot_x, hot_y;
  char *cursor_png;
  const char *cursor_shape;
} g;

static GVariant *call(const char *name, const char *path, const char *iface,
                      const char *method, GVariant *args, const char *type) {
  GError *error = NULL;
  GVariant *result = g_dbus_connection_call_sync(
      bus, name, path, iface, method, args, type ? G_VARIANT_TYPE(type) : NULL,
      G_DBUS_CALL_FLAGS_NONE, 3000, NULL, &error);
  if (error)
    g_error_free(error);
  return result;
}
static int valid_connector(const char *name) {
  size_t n = strlen(name);
  if (!n || n > 80)
    return 0;
  for (size_t i = 0; i < n; i++)
    if (!(g_ascii_isalnum(name[i]) || name[i] == '_' || name[i] == '.' ||
          name[i] == '-'))
      return 0;
  return 1;
}
static void json_string(const char *text) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p == '"' || *p == '\\')
      printf("\\%c", *p);
    else if (*p < 0x20)
      printf("\\u%04x", *p);
    else
      putchar(*p);
  }
  putchar('"');
}

/* Logical monitors in Mutter's layout. Sizes are logical (desktop points)
 * in the default logical layout mode; `scale` converts stream pixels. */
static int print_monitors(void) {
  GVariant *state = call(
      "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
      "org.gnome.Mutter.DisplayConfig", "GetCurrentState", NULL,
      "(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})");
  if (!state)
    return 1;
  GVariant *monitors = g_variant_get_child_value(state, 1);
  GVariant *logical = g_variant_get_child_value(state, 2);
  GVariant *properties = g_variant_get_child_value(state, 3);
  guint32 layout = 1;
  g_variant_lookup(properties, "layout-mode", "u", &layout);
  int first = 1, count = 0;
  putchar('[');
  for (gsize i = 0; i < g_variant_n_children(logical) && count < 32; i++) {
    gint32 x, y;
    gdouble scale;
    guint32 transform;
    gboolean primary;
    GVariant *members, *unused;
    g_variant_get_child(logical, i, "(iidub@a(ssss)@a{sv})", &x, &y, &scale,
                        &transform, &primary, &members, &unused);
    g_variant_unref(unused);
    const char *connector = NULL;
    if (g_variant_n_children(members))
      g_variant_get_child(members, 0, "(&s&s&s&s)", &connector, NULL, NULL,
                          NULL);
    /* The first member's current mode sizes a mirrored logical monitor. */
    gint32 width = 0, height = 0;
    const char *name = "";
    GVariant *display_name = NULL;
    for (gsize m = 0; connector && m < g_variant_n_children(monitors); m++) {
      GVariant *monitor = g_variant_get_child_value(monitors, m);
      const char *candidate;
      g_variant_get_child(monitor, 0, "(&s&s&s&s)", &candidate, NULL, NULL,
                          NULL);
      if (!strcmp(candidate, connector)) {
        GVariant *modes = g_variant_get_child_value(monitor, 1);
        for (gsize k = 0; k < g_variant_n_children(modes); k++) {
          gint32 w, h;
          GVariant *mode_properties;
          g_variant_get_child(modes, k, "(&siiddad@a{sv})", NULL, &w, &h, NULL,
                              NULL, NULL, &mode_properties);
          gboolean current = FALSE;
          g_variant_lookup(mode_properties, "is-current", "b", &current);
          g_variant_unref(mode_properties);
          if (current) {
            width = w;
            height = h;
          }
        }
        g_variant_unref(modes);
        GVariant *monitor_properties = g_variant_get_child_value(monitor, 2);
        display_name = g_variant_lookup_value(monitor_properties,
                                              "display-name", G_VARIANT_TYPE_STRING);
        if (display_name)
          name = g_variant_get_string(display_name, NULL);
        g_variant_unref(monitor_properties);
      }
      g_variant_unref(monitor);
    }
    /* Odd transforms rotate by 90 or 270 degrees. */
    if (transform & 1) {
      gint32 swap = width;
      width = height;
      height = swap;
    }
    double effective = layout == 1 ? scale : 1;
    if (connector && valid_connector(connector) && width > 0 && height > 0 &&
        width <= 16384 && height <= 16384 && isfinite(effective) &&
        effective >= 0.25 && effective <= 8) {
      if (!first)
        putchar(',');
      first = 0;
      count++;
      printf("{\"id\":");
      json_string(connector);
      printf(",\"name\":");
      json_string(name);
      printf(",\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d,\"scale\":%.6f,"
             "\"primary\":%s}",
             x, y, (int)lround(width / effective),
             (int)lround(height / effective), effective,
             primary ? "true" : "false");
    }
    if (display_name)
      g_variant_unref(display_name);
    g_variant_unref(members);
  }
  puts("]");
  g_variant_unref(properties);
  g_variant_unref(logical);
  g_variant_unref(monitors);
  g_variant_unref(state);
  return fflush(stdout) ? 1 : 0;
}

/* --- Cursor shape from the theme ---------------------------------------- */
static char *cursor_theme;
static int cursor_size = 24;
static void read_cursor_theme(void) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  GSettingsSchema *schema =
      source ? g_settings_schema_source_lookup(
                   source, "org.gnome.desktop.interface", TRUE)
             : NULL;
  if (!schema)
    return;
  GSettings *settings = g_settings_new_full(schema, NULL, NULL);
  cursor_theme = g_settings_get_string(settings, "cursor-theme");
  cursor_size = g_settings_get_int(settings, "cursor-size");
  g_object_unref(settings);
  g_settings_schema_unref(schema);
}
/* Mutter premultiplies the theme's already-premultiplied Xcursor pixels once
 * more (GNOME 46), so accept either form within GPU rounding. */
static int same_raster(const XcursorImage *image, const unsigned char *rgba,
                       int width, int height, int hot_x, int hot_y) {
  if ((int)image->width != width || (int)image->height != height ||
      (int)image->xhot != hot_x || (int)image->yhot != hot_y)
    return 0;
  int direct = 1, twice = 1;
  for (int i = 0; i < width * height && (direct || twice); i++) {
    XcursorPixel p = image->pixels[i];
    const unsigned char *q = rgba + (size_t)i * 4;
    int alpha = (int)(p >> 24);
    if (abs(alpha - q[3]) > 3)
      return 0;
    for (int c = 0; c < 3; c++) {
      int theirs = (int)((p >> (16 - 8 * c)) & 255);
      if (abs(theirs - q[c]) > 3)
        direct = 0;
      if (abs((theirs * alpha + 127) / 255 - q[c]) > 3)
        twice = 0;
    }
  }
  return direct || twice;
}
static uint32_t raster_hash(const unsigned char *rgba, size_t size) {
  uint32_t hash = 2166136261u;
  for (size_t i = 0; i < size; i++)
    hash = (hash ^ rgba[i]) * 16777619u;
  return hash;
}
/* Called only when the raster changes; a small cache covers the few shapes a
 * session alternates between, so theme files are read once per shape. */
static const char *match_shape(const unsigned char *premultiplied, int width,
                               int height, int hot_x, int hot_y) {
  static struct {
    uint32_t hash;
    int width, height;
    const char *shape;
    int used;
  } cache[16];
  static unsigned next;
  uint32_t hash = raster_hash(premultiplied, (size_t)width * height * 4) ^
                  (uint32_t)(hot_x << 16 | hot_y);
  for (unsigned i = 0; i < 16; i++)
    if (cache[i].used && cache[i].hash == hash && cache[i].width == width &&
        cache[i].height == height)
      return cache[i].shape;
  const char *shape = NULL;
  for (size_t i = 0; i < CURSOR_SHAPE_COUNT && !shape; i++)
    for (size_t j = 0;
         j < CURSOR_SHAPE_NAMES && cursor_shapes[i].names[j] && !shape; j++) {
      XcursorImages *images = XcursorLibraryLoadImages(
          cursor_shapes[i].names[j], cursor_theme, height);
      if (!images)
        continue;
      for (int k = 0; k < images->nimage && !shape; k++)
        if (same_raster(images->images[k], premultiplied, width, height, hot_x,
                        hot_y))
          shape = cursor_shapes[i].shape;
      XcursorImagesDestroy(images);
    }
  cache[next].hash = hash;
  cache[next].width = width;
  cache[next].height = height;
  cache[next].shape = shape;
  cache[next].used = 1;
  next = (next + 1) % 16;
  return shape;
}
static void read_cursor(struct spa_buffer *buffer) {
  struct spa_meta *meta = spa_buffer_find_meta(buffer, SPA_META_Cursor);
  if (!meta || meta->size < sizeof(struct spa_meta_cursor))
    return;
  struct spa_meta_cursor *cursor = meta->data;
  /* id 0: no pointer over this monitor (or hidden). */
  if (!spa_meta_cursor_is_valid(cursor)) {
    g.cursor_visible = 0;
    return;
  }
  g.cursor_visible = 1;
  g.cursor_x = cursor->position.x;
  g.cursor_y = cursor->position.y;
  if (!cursor->bitmap_offset)
    return; /* Position-only update; the raster is unchanged. */
  if (cursor->bitmap_offset < sizeof(*cursor) ||
      cursor->bitmap_offset > meta->size - sizeof(struct spa_meta_bitmap))
    return;
  struct spa_meta_bitmap *bitmap =
      SPA_PTROFF(cursor, cursor->bitmap_offset, struct spa_meta_bitmap);
  uint32_t width = bitmap->size.width, height = bitmap->size.height;
  g.cursor_known = 1;
  free(g.cursor_png);
  g.cursor_png = NULL;
  g.cursor_opaque = 0;
  if (!width || !height)
    return; /* An empty raster is a hidden pointer. */
  int bgra = bitmap->format == SPA_VIDEO_FORMAT_BGRA;
  if ((!bgra && bitmap->format != SPA_VIDEO_FORMAT_RGBA) || width > 256 ||
      height > 256 || bitmap->stride < (int32_t)(width * 4) ||
      bitmap->offset > meta->size - cursor->bitmap_offset ||
      (size_t)bitmap->stride * (height - 1) + width * 4 >
          meta->size - cursor->bitmap_offset - bitmap->offset)
    return;
  const unsigned char *pixels = SPA_PTROFF(bitmap, bitmap->offset, uint8_t);
  size_t count = (size_t)width * height;
  unsigned char *premultiplied = malloc(count * 4), *rgba = malloc(count * 4);
  if (premultiplied && rgba) {
    /* Mutter renders premultiplied RGBA; a channel above alpha means the
     * producer sent straight alpha instead. */
    int straight = 0;
    for (uint32_t y = 0; y < height; y++)
      for (uint32_t x = 0; x < width; x++) {
        const unsigned char *s = pixels + (size_t)y * bitmap->stride + x * 4;
        unsigned char *d = premultiplied + ((size_t)y * width + x) * 4;
        d[0] = s[bgra ? 2 : 0];
        d[1] = s[1];
        d[2] = s[bgra ? 0 : 2];
        d[3] = s[3];
        if (d[0] > d[3] || d[1] > d[3] || d[2] > d[3])
          straight = 1;
      }
    for (size_t i = 0; i < count; i++) {
      unsigned char *p = premultiplied + i * 4, *q = rgba + i * 4;
      unsigned a = p[3];
      if (a)
        g.cursor_opaque = 1;
      for (int c = 0; c < 3; c++) {
        q[c] = straight ? p[c] : cindy_unpremultiply(p[c], a);
        if (straight)
          p[c] = (unsigned char)((p[c] * a + 127) / 255);
      }
      q[3] = (unsigned char)a;
    }
    g.cursor_png = cindy_png_base64(rgba, (int)width, (int)height);
    g.cursor_width = (int)width;
    g.cursor_height = (int)height;
    g.hot_x = cursor->hotspot.x;
    g.hot_y = cursor->hotspot.y;
    g.cursor_shape = g.cursor_opaque
                         ? match_shape(premultiplied, (int)width, (int)height,
                                       g.hot_x, g.hot_y)
                         : NULL;
  }
  free(premultiplied);
  free(rgba);
}
static void cursor_json(void) {
  if (!g.cursor_known || !g.cursor_png || !g.width || g.hot_x < 0 ||
      g.hot_y < 0 || g.hot_x > g.cursor_width || g.hot_y > g.cursor_height) {
    fputs("null", stdout);
    return;
  }
  double scale = g.scale > 0 ? g.scale : 1;
  int inside = g.cursor_x >= 0 && g.cursor_y >= 0 &&
               g.cursor_x < (int)g.width && g.cursor_y < (int)g.height;
  double x = g.width > 1 ? (double)g.cursor_x / (g.width - 1) : 0;
  double y = g.height > 1 ? (double)g.cursor_y / (g.height - 1) : 0;
  printf("{\"visible\":%s,\"x\":%.6f,\"y\":%.6f,\"width\":%.3f,"
         "\"height\":%.3f,\"hotX\":%.3f,\"hotY\":%.3f,\"png\":\"%s\"",
         g.cursor_visible && g.cursor_opaque && inside ? "true" : "false",
         fmax(0, fmin(1, x)), fmax(0, fmin(1, y)), g.cursor_width / scale,
         g.cursor_height / scale, g.hot_x / scale, g.hot_y / scale,
         g.cursor_png);
  if (g.cursor_shape)
    printf(",\"shape\":\"%s\"", g.cursor_shape);
  fputc('}', stdout);
}

/* --- PipeWire stream ---------------------------------------------------- */
static void on_param_changed(void *data, uint32_t id,
                             const struct spa_pod *param) {
  (void)data;
  if (!param || id != SPA_PARAM_Format)
    return;
  uint32_t media_type, media_subtype;
  struct spa_video_info_raw info = {0};
  if (spa_format_parse(param, &media_type, &media_subtype) < 0 ||
      media_type != SPA_MEDIA_TYPE_video ||
      media_subtype != SPA_MEDIA_SUBTYPE_raw ||
      spa_format_video_raw_parse(param, &info) < 0 || !info.size.width ||
      !info.size.height || info.size.width > 8192 ||
      info.size.height > 8192 ||
      (uint64_t)info.size.width * info.size.height > 16777216) {
    g.failed = 1;
    return;
  }
  if (info.format == SPA_VIDEO_FORMAT_BGRx ||
      info.format == SPA_VIDEO_FORMAT_BGRA)
    g.bgrx = 1;
  else if (info.format == SPA_VIDEO_FORMAT_RGBx ||
           info.format == SPA_VIDEO_FORMAT_RGBA)
    g.bgrx = 0;
  else {
    g.failed = 1;
    return;
  }
  /* A new size invalidates the previous picture and its cursor scale. */
  g.width = info.size.width;
  g.height = info.size.height;
  g.frame_serial++;
  free(g.frame);
  g.frame = NULL;
  g.frame_size = 0;
  uint8_t buffer[1024];
  struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
  const struct spa_pod *params[3];
  uint32_t count = 0;
  /* Shared memory only: no DMA-BUF modifiers are offered, so no GPU import. */
  params[count++] = spa_pod_builder_add_object(
      &b, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
      SPA_PARAM_BUFFERS_dataType,
      SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemFd) | (1 << SPA_DATA_MemPtr)));
  params[count++] = spa_pod_builder_add_object(
      &b, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta, SPA_PARAM_META_type,
      SPA_POD_Id(SPA_META_Header), SPA_PARAM_META_size,
      SPA_POD_Int(sizeof(struct spa_meta_header)));
  if (g.overlay)
    params[count++] = spa_pod_builder_add_object(
        &b, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta, SPA_PARAM_META_type,
        SPA_POD_Id(SPA_META_Cursor), SPA_PARAM_META_size,
        /* Mutter offers up to 384x384 (its large accessibility cursors). A
         * range that excludes its default does not negotiate at all. Rasters
         * beyond the protocol's 256x256 are dropped in read_cursor. */
        SPA_POD_CHOICE_RANGE_Int(CURSOR_META_SIZE(384, 384),
                                 CURSOR_META_SIZE(1, 1),
                                 CURSOR_META_SIZE(1024, 1024)));
  pw_stream_update_params(g.stream, params, count);
}
static void on_process(void *data) {
  (void)data;
  struct pw_buffer *b;
  while ((b = pw_stream_dequeue_buffer(g.stream))) {
    struct spa_buffer *buffer = b->buffer;
    /* Metadata may arrive without pixels when only the pointer moved. */
    if (g.overlay)
      read_cursor(buffer);
    struct spa_meta_header *header =
        spa_buffer_find_meta_data(buffer, SPA_META_Header, sizeof(*header));
    struct spa_data *d = &buffer->datas[0];
    int corrupted = (header && (header->flags & SPA_META_HEADER_FLAG_CORRUPTED)) ||
                    (d->chunk->flags & SPA_CHUNK_FLAG_CORRUPTED);
    uint32_t row = g.width * 4;
    uint32_t stride = d->chunk->stride > 0 ? (uint32_t)d->chunk->stride : row;
    if (!corrupted && d->data && d->chunk->size && g.width && stride >= row &&
        d->chunk->offset <= d->maxsize &&
        (size_t)stride * (g.height - 1) + row <=
            d->maxsize - d->chunk->offset) {
      size_t size = (size_t)row * g.height;
      if (g.frame_size != size) {
        free(g.frame);
        g.frame = malloc(size);
        g.frame_size = g.frame ? size : 0;
      }
      if (g.frame) {
        const unsigned char *source =
            (const unsigned char *)d->data + d->chunk->offset;
        for (uint32_t y = 0; y < g.height; y++)
          memcpy(g.frame + (size_t)y * row, source + (size_t)y * stride, row);
        g.frame_serial++;
      }
    }
    pw_stream_queue_buffer(g.stream, b);
  }
}
static void on_state_changed(void *data, enum pw_stream_state old,
                             enum pw_stream_state state, const char *error) {
  (void)data;
  (void)old;
  (void)error;
  if (state == PW_STREAM_STATE_ERROR || state == PW_STREAM_STATE_UNCONNECTED)
    g.failed = 1;
}
static const struct pw_stream_events stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = on_state_changed,
    .param_changed = on_param_changed,
    .process = on_process,
};
static void on_core_error(void *data, uint32_t id, int seq, int res,
                          const char *message) {
  (void)data;
  (void)seq;
  (void)res;
  (void)message;
  if (id == PW_ID_CORE)
    g.failed = 1;
}
static const struct pw_core_events core_events = {
    PW_VERSION_CORE_EVENTS,
    .error = on_core_error,
};
static int connect_stream(void) {
  g.context = pw_context_new(g.loop, NULL, 0);
  g.core = g.context ? pw_context_connect(g.context, NULL, 0) : NULL;
  if (!g.core)
    return -1;
  pw_core_add_listener(g.core, &g.core_listener, &core_events, NULL);
  g.stream = pw_stream_new(
      g.core, "Cindy remote desktop",
      pw_properties_new(PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY,
                        "Capture", PW_KEY_MEDIA_ROLE, "Screen", NULL));
  if (!g.stream)
    return -1;
  pw_stream_add_listener(g.stream, &g.stream_listener, &stream_events, NULL);
  uint8_t buffer[1024];
  struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
  struct spa_rectangle size = SPA_RECTANGLE(1920, 1080),
                       min_size = SPA_RECTANGLE(1, 1),
                       max_size = SPA_RECTANGLE(8192, 8192);
  struct spa_fraction rate = SPA_FRACTION(60, 1), min_rate = SPA_FRACTION(0, 1),
                      max_rate = SPA_FRACTION(1000, 1);
  const struct spa_pod *params[1] = {spa_pod_builder_add_object(
      &b, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat, SPA_FORMAT_mediaType,
      SPA_POD_Id(SPA_MEDIA_TYPE_video), SPA_FORMAT_mediaSubtype,
      SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw), SPA_FORMAT_VIDEO_format,
      SPA_POD_CHOICE_ENUM_Id(5, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx,
                             SPA_VIDEO_FORMAT_BGRA, SPA_VIDEO_FORMAT_RGBx,
                             SPA_VIDEO_FORMAT_RGBA),
      SPA_FORMAT_VIDEO_size,
      SPA_POD_CHOICE_RANGE_Rectangle(&size, &min_size, &max_size),
      SPA_FORMAT_VIDEO_framerate,
      SPA_POD_CHOICE_RANGE_Fraction(&rate, &min_rate, &max_rate))};
  return pw_stream_connect(g.stream, PW_DIRECTION_INPUT, g.node,
                           PW_STREAM_FLAG_AUTOCONNECT |
                               PW_STREAM_FLAG_MAP_BUFFERS,
                           params, 1) < 0
             ? -1
             : 0;
}

/* --- Mutter session ----------------------------------------------------- */
static void on_stream_added(GDBusConnection *connection, const gchar *sender,
                            const gchar *path, const gchar *iface,
                            const gchar *signal, GVariant *parameters,
                            gpointer data) {
  (void)connection;
  (void)sender;
  (void)path;
  (void)iface;
  (void)signal;
  (void)data;
  if (g_variant_is_of_type(parameters, G_VARIANT_TYPE("(u)")))
    g_variant_get(parameters, "(u)", &g.node);
}
static void on_closed(GDBusConnection *connection, const gchar *sender,
                      const gchar *path, const gchar *iface,
                      const gchar *signal, GVariant *parameters,
                      gpointer data) {
  (void)connection;
  (void)sender;
  (void)path;
  (void)iface;
  (void)signal;
  (void)parameters;
  (void)data;
  g.closed = 1;
}
static int start_session(const char *connector) {
  GVariantBuilder options;
  g_variant_builder_init(&options, G_VARIANT_TYPE("a{sv}"));
  GVariant *reply =
      call(SCREEN_CAST, SCREEN_CAST_PATH, SCREEN_CAST, "CreateSession",
           g_variant_new("(a{sv})", &options), "(o)");
  if (!reply)
    return -1;
  g_variant_get(reply, "(o)", &g.session);
  g_variant_unref(reply);
  g_dbus_connection_signal_subscribe(bus, SCREEN_CAST, SCREEN_CAST_SESSION,
                                     "Closed", g.session, NULL,
                                     G_DBUS_SIGNAL_FLAGS_NONE, on_closed, NULL,
                                     NULL);
  g_variant_builder_init(&options, G_VARIANT_TYPE("a{sv}"));
  /* 2 = metadata (cursor-free video), 1 = cursor embedded in the video. */
  g_variant_builder_add(&options, "{sv}", "cursor-mode",
                        g_variant_new_uint32(g.overlay ? 2 : 1));
  reply = call(SCREEN_CAST, g.session, SCREEN_CAST_SESSION, "RecordMonitor",
               g_variant_new("(sa{sv})", connector, &options), "(o)");
  if (!reply)
    return -1;
  const char *stream;
  g_variant_get(reply, "(&o)", &stream);
  g_dbus_connection_signal_subscribe(
      bus, SCREEN_CAST, "org.gnome.Mutter.ScreenCast.Stream",
      "PipeWireStreamAdded", stream, NULL, G_DBUS_SIGNAL_FLAGS_NONE,
      on_stream_added, NULL, NULL);
  g_variant_unref(reply);
  reply = call(SCREEN_CAST, g.session, SCREEN_CAST_SESSION, "Start", NULL,
               NULL);
  if (!reply)
    return -1;
  g_variant_unref(reply);
  /* Bounded by the caller's alarm. */
  while (!g.node && !g.closed)
    g_main_context_iteration(NULL, TRUE);
  return g.node ? 0 : -1;
}
static void stop_session(void) {
  if (g.stream)
    pw_stream_destroy(g.stream);
  if (g.core)
    pw_core_disconnect(g.core);
  if (g.context)
    pw_context_destroy(g.context);
  g.stream = NULL;
  g.core = NULL;
  g.context = NULL;
  if (g.session && !g.closed) {
    GVariant *reply = call(SCREEN_CAST, g.session, SCREEN_CAST_SESSION, "Stop",
                           NULL, NULL);
    if (reply)
      g_variant_unref(reply);
  }
  g_free(g.session);
  g.session = NULL;
}

static int send_frame(void) {
  if (g.encoded_serial != g.frame_serial || !g.line) {
    /* Unchanged pixels reuse the previous encoding (Mutter only sends damage). */
    free(g.line);
    g.line = NULL;
    int width, height, stride;
    const unsigned char *pixels =
        cindy_scale_pixels(g.frame, g.width, g.height, g.width * 4, &g.scaled,
                           &width, &height, &stride);
    if (!pixels)
      return -1;
    unsigned char *jpeg = NULL;
    unsigned long length = 0;
    for (int quality = g.quality; quality >= 25; quality -= 20) {
      jpeg_release(jpeg);
      jpeg = NULL;
      if (jpeg_encode(pixels, width, stride, height, g.bgrx, 0, quality, &jpeg,
                      &length))
        return -1;
      if (length <= 1000000)
        break;
    }
    if (length > 1000000) {
      jpeg_release(jpeg);
      return -1;
    }
    g.line = cindy_base64(jpeg, length);
    jpeg_release(jpeg);
    if (!g.line)
      return -1;
    g.encoded_serial = g.frame_serial;
  }
  if (g.overlay) {
    printf("{\"jpeg\":\"%s\",\"cursor\":", g.line);
    cursor_json();
    fputs("}\n", stdout);
  } else {
    fputs(g.line, stdout);
    fputc('\n', stdout);
  }
  return ferror(stdout) || fflush(stdout) ? -1 : 0;
}

static int check(void) {
  const char *names[] = {SCREEN_CAST, "org.gnome.Mutter.RemoteDesktop",
                         "org.gnome.Mutter.DisplayConfig"};
  for (size_t i = 0; i < 3; i++) {
    GVariant *reply = call("org.freedesktop.DBus", "/org/freedesktop/DBus",
                           "org.freedesktop.DBus", "NameHasOwner",
                           g_variant_new("(s)", names[i]), "(b)");
    gboolean owned = FALSE;
    if (reply) {
      g_variant_get(reply, "(b)", &owned);
      g_variant_unref(reply);
    }
    if (!owned)
      return 1;
  }
  /* The metadata cursor mode needs ScreenCast API version 2 or later. */
  GVariant *version = call(SCREEN_CAST, SCREEN_CAST_PATH,
                           "org.freedesktop.DBus.Properties", "Get",
                           g_variant_new("(ss)", SCREEN_CAST, "Version"), "(v)");
  gint32 value = 0;
  if (version) {
    GVariant *inner;
    g_variant_get(version, "(v)", &inner);
    if (g_variant_is_of_type(inner, G_VARIANT_TYPE_INT32))
      value = g_variant_get_int32(inner);
    g_variant_unref(inner);
    g_variant_unref(version);
  }
  if (value < 2 || jpeg_open())
    return 1;
  pw_init(NULL, NULL);
  struct pw_loop *loop = pw_loop_new(NULL);
  struct pw_context *context = loop ? pw_context_new(loop, NULL, 0) : NULL;
  struct pw_core *core = context ? pw_context_connect(context, NULL, 0) : NULL;
  int ready = core != NULL;
  if (core)
    pw_core_disconnect(core);
  if (context)
    pw_context_destroy(context);
  if (loop)
    pw_loop_destroy(loop);
  if (ready)
    puts("ready");
  return ready ? 0 : 1;
}

/* Wayland sessions only: never record through an X11 or XWayland identity. */
static int gnome_session(void) {
  const char *type = getenv("XDG_SESSION_TYPE");
  const char *wayland = getenv("WAYLAND_DISPLAY");
  return (type && !strcmp(type, "wayland")) || (wayland && *wayland);
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  alarm(5);
  int probe = argc == 2 && !strcmp(argv[1], "--check");
  int monitors = argc == 2 && !strcmp(argv[1], "--monitors");
  if (!probe && !monitors) {
    if (argc != 5 || strncmp(argv[4], "gnome:", 6) ||
        !valid_connector(argv[4] + 6))
      return 2;
    g.overlay = !strcmp(argv[1], "cursor-overlay");
    if (!g.overlay && strcmp(argv[1], "video"))
      return 2;
    g.scale = strtod(argv[2], NULL);
    g.quality = atoi(argv[3]);
    if (!isfinite(g.scale) || g.scale < 0.25 || g.scale > 8 ||
        g.quality < 25 || g.quality > 95)
      return 2;
  }
  if (!gnome_session())
    return 1;
  bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
  if (!bus)
    return 1;
  if (probe)
    return check();
  if (monitors)
    return print_monitors();
  int status = 1;
  if (jpeg_open())
    return 1;
  if (g.overlay)
    read_cursor_theme();
  pw_init(NULL, NULL);
  g.loop = pw_loop_new(NULL);
  if (!g.loop || start_session(argv[4] + 6))
    goto done;
  pw_loop_enter(g.loop);
  if (connect_stream()) {
    pw_loop_leave(g.loop);
    goto done;
  }
  int pending = 0;
  for (;;) {
    struct pollfd fds[2] = {{STDIN_FILENO, POLLIN, 0},
                            {pw_loop_get_fd(g.loop), POLLIN, 0}};
    /* The short tick also services D-Bus signals (session closed). */
    if (poll(fds, 2, 50) < 0)
      break;
    if (fds[1].revents)
      pw_loop_iterate(g.loop, 0);
    while (g_main_context_iteration(NULL, FALSE))
      ;
    if (g.closed || g.failed)
      break;
    if (fds[0].revents & (POLLIN | POLLHUP)) {
      char command;
      ssize_t n = read(STDIN_FILENO, &command, 1);
      if (!n) {
        status = 0;
        break;
      }
      if (n != 1 || command != 'f' || pending)
        break;
      pending = 1;
      alarm(3);
    }
    if (pending && g.frame) {
      if (send_frame())
        break;
      pending = 0;
      /* Idle watchdog for an orphaned helper. */
      alarm(10);
    }
  }
  pw_loop_leave(g.loop);
done:
  stop_session();
  if (g.loop)
    pw_loop_destroy(g.loop);
  pw_deinit();
  jpeg_close();
  free(g.frame);
  free(g.scaled);
  free(g.line);
  free(g.cursor_png);
  g_free(cursor_theme);
  g_object_unref(bus);
  return status;
}
