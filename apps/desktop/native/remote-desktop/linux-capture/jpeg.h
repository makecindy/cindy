/* JPEG encoding resolved at runtime. Stock Ubuntu has no libturbojpeg, but
 * every GTK desktop that runs Electron ships gdk-pixbuf with its system-matched
 * libjpeg. TurboJPEG stays the fast path wherever it is installed (Arch, the
 * managed cloud image); gdk-pixbuf keeps the helper usable everywhere else.
 * Neither backend writes files or keeps frames beyond the call. */
#include <dlfcn.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* TurboJPEG's stable ABI values (turbojpeg.h, unchanged since 1.2). */
enum {
  CINDY_TJPF_RGBX = 2,
  CINDY_TJPF_BGRX = 3,
  CINDY_TJSAMP_420 = 2,
  CINDY_TJFLAG_BOTTOMUP = 2,
  CINDY_TJFLAG_FASTDCT = 2048
};
struct jpeg_backend {
  void *library;
  void *handle;
  void *(*tj_init)(void);
  int (*tj_compress)(void *, const unsigned char *, int, int, int, int,
                     unsigned char **, unsigned long *, int, int, int);
  void (*tj_free)(unsigned char *);
  int (*tj_destroy)(void *);
  void *(*pixbuf_new)(const unsigned char *, int, int, int, int, int, int,
                      void *, void *);
  int (*pixbuf_save)(void *, char **, size_t *, const char *, char **,
                     char **, void **);
  void (*object_unref)(void *);
  void (*error_free)(void *);
  void (*g_free)(void *);
  unsigned char *rgb;
  size_t rgb_size;
};
static struct jpeg_backend jb;
static void *jpeg_symbol(const char *name) {
  return jb.library ? dlsym(jb.library, name) : NULL;
}
/* Libraries stay loaded: gdk-pixbuf registers GObject types and caches its
 * loaders, neither of which survives dlclose. The helper's exit releases them. */
static void jpeg_close(void) {
  if (jb.handle && jb.tj_destroy)
    jb.tj_destroy(jb.handle);
  free(jb.rgb);
  memset(&jb, 0, sizeof(jb));
}
static int jpeg_open(void) {
  if (jb.library)
    return 0;
  jb.library = dlopen("libturbojpeg.so.0", RTLD_NOW | RTLD_LOCAL);
  if (jb.library) {
    *(void **)&jb.tj_init = jpeg_symbol("tjInitCompress");
    *(void **)&jb.tj_compress = jpeg_symbol("tjCompress2");
    *(void **)&jb.tj_free = jpeg_symbol("tjFree");
    *(void **)&jb.tj_destroy = jpeg_symbol("tjDestroy");
    if (jb.tj_init && jb.tj_compress && jb.tj_free && jb.tj_destroy &&
        (jb.handle = jb.tj_init()))
      return 0;
    jpeg_close();
  }
  /* dlsym on the handle also searches its glib/gobject dependencies. */
  jb.library = dlopen("libgdk_pixbuf-2.0.so.0", RTLD_NOW | RTLD_LOCAL);
  if (!jb.library)
    return -1;
  *(void **)&jb.pixbuf_new = jpeg_symbol("gdk_pixbuf_new_from_data");
  *(void **)&jb.pixbuf_save = jpeg_symbol("gdk_pixbuf_save_to_bufferv");
  *(void **)&jb.object_unref = jpeg_symbol("g_object_unref");
  *(void **)&jb.error_free = jpeg_symbol("g_error_free");
  *(void **)&jb.g_free = jpeg_symbol("g_free");
  if (jb.pixbuf_new && jb.pixbuf_save && jb.object_unref && jb.error_free &&
      jb.g_free)
    return 0;
  jpeg_close();
  return -1;
}
/* Encode 32-bit pixels. `bgrx` selects byte order; `bottom_up` reads rows
 * upward. On success *out must be released with jpeg_release(). */
static int jpeg_encode(const unsigned char *pixels, int width, int stride,
                       int height, int bgrx, int bottom_up, int quality,
                       unsigned char **out, unsigned long *length) {
  *out = NULL;
  *length = 0;
  if (width <= 0 || height <= 0 || stride < width * 4 || quality < 1 ||
      quality > 100 || jpeg_open())
    return -1;
  if (jb.handle)
    return jb.tj_compress(jb.handle, pixels, width, stride, height,
                          bgrx ? CINDY_TJPF_BGRX : CINDY_TJPF_RGBX, out,
                          length, CINDY_TJSAMP_420, quality,
                          CINDY_TJFLAG_FASTDCT |
                              (bottom_up ? CINDY_TJFLAG_BOTTOMUP : 0))
               ? -1
               : 0;
  size_t row = (size_t)width * 3, size = row * (size_t)height;
  if (size > jb.rgb_size) {
    unsigned char *next = realloc(jb.rgb, size);
    if (!next)
      return -1;
    jb.rgb = next;
    jb.rgb_size = size;
  }
  int r = bgrx ? 2 : 0, b = bgrx ? 0 : 2;
  for (int y = 0; y < height; y++) {
    const unsigned char *source =
        pixels + (size_t)(bottom_up ? height - 1 - y : y) * (size_t)stride;
    unsigned char *dest = jb.rgb + (size_t)y * row;
    for (int x = 0; x < width; x++) {
      dest[x * 3] = source[x * 4 + r];
      dest[x * 3 + 1] = source[x * 4 + 1];
      dest[x * 3 + 2] = source[x * 4 + b];
    }
  }
  /* GDK_COLORSPACE_RGB, no alpha, 8 bits per sample; the pixbuf borrows rgb. */
  void *pixbuf = jb.pixbuf_new(jb.rgb, 0, 0, 8, width, height, (int)row, NULL,
                               NULL);
  if (!pixbuf)
    return -1;
  char value[4];
  snprintf(value, sizeof(value), "%d", quality);
  char *keys[] = {"quality", NULL}, *values[] = {value, NULL};
  char *buffer = NULL;
  size_t size_out = 0;
  void *error = NULL;
  int ok = jb.pixbuf_save(pixbuf, &buffer, &size_out, "jpeg", keys, values,
                          &error);
  jb.object_unref(pixbuf);
  if (error)
    jb.error_free(error);
  if (!ok || !buffer) {
    if (buffer)
      jb.g_free(buffer);
    return -1;
  }
  *out = (unsigned char *)buffer;
  *length = (unsigned long)size_out;
  return 0;
}
static void jpeg_release(unsigned char *jpeg) {
  if (!jpeg)
    return;
  if (jb.handle)
    jb.tj_free(jpeg);
  else if (jb.g_free)
    jb.g_free(jpeg);
}
