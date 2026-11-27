/* Bounded encoders shared by the X11 and GNOME backends: base64 text for the
 * line protocol, a PNG cursor raster, and the 1920-pixel video downscale. */
#ifndef CINDY_CAPTURE_ENCODE_H
#define CINDY_CAPTURE_ENCODE_H
#include <png.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static char *cindy_base64(const unsigned char *bytes, size_t length) {
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
/* Straight (non-premultiplied) RGBA to base64 PNG. The 48 KiB bound keeps
 * the text within the cursor protocol's 64 KiB limit. */
static char *cindy_png_base64(const unsigned char *rgba, int width,
                              int height) {
  png_image image = {.version = PNG_IMAGE_VERSION,
                     .width = (png_uint_32)width,
                     .height = (png_uint_32)height,
                     .format = PNG_FORMAT_RGBA};
  char *result = NULL;
  png_alloc_size_t size = 0;
  if (width > 0 && height > 0 && width <= 256 && height <= 256 &&
      png_image_write_to_memory(&image, NULL, &size, 0, rgba, 0, NULL) &&
      size <= 49152) {
    unsigned char *png = malloc(size);
    if (png && png_image_write_to_memory(&image, png, &size, 0, rgba, 0, NULL))
      result = cindy_base64(png, size);
    free(png);
  }
  png_image_free(&image);
  return result;
}
/* Premultiplied 8-bit channel to straight alpha. */
static unsigned char cindy_unpremultiply(unsigned value, unsigned alpha) {
  if (!alpha)
    return 0;
  unsigned v = (value * 255 + alpha / 2) / alpha;
  return (unsigned char)(v > 255 ? 255 : v);
}
/* Match the normal desktop video's 1920-pixel long-edge cap before IPC and
 * decoding. Bilinear sampling preserves aspect ratio and supports padded
 * rows. *scratch is allocated once (1920x1920x4) and reused by the caller. */
static const unsigned char *cindy_scale_pixels(const unsigned char *pixels,
                                               uint32_t source_width,
                                               uint32_t source_height,
                                               uint32_t source_stride,
                                               unsigned char **scratch,
                                               int *width, int *height,
                                               int *stride) {
  *width = (int)source_width;
  *height = (int)source_height;
  *stride = (int)source_stride;
  uint32_t edge = source_width > source_height ? source_width : source_height;
  if (edge <= 1920)
    return pixels;
  *width = (int)(source_width * 1920 / edge);
  *height = (int)(source_height * 1920 / edge);
  if (*width < 1)
    *width = 1;
  if (*height < 1)
    *height = 1;
  *stride = *width * 4;
  if (!*scratch)
    *scratch = malloc(1920 * 1920 * 4);
  if (!*scratch)
    return NULL;
  uint32_t xs[1920], weights[1920];
  for (int x = 0; x < *width; x++) {
    uint32_t pos =
        *width > 1
            ? (uint32_t)((uint64_t)x * (source_width - 1) * 256 / (*width - 1))
            : 0;
    xs[x] = pos >> 8;
    weights[x] = pos & 255;
  }
  for (int y = 0; y < *height; y++) {
    uint32_t pos = *height > 1 ? (uint32_t)((uint64_t)y * (source_height - 1) *
                                            256 / (*height - 1))
                               : 0;
    uint32_t sy = pos >> 8, wy = pos & 255;
    uint32_t next = sy + 1 < source_height ? sy + 1 : sy;
    const unsigned char *a = pixels + (size_t)sy * source_stride;
    const unsigned char *b = pixels + (size_t)next * source_stride;
    unsigned char *dest = *scratch + (size_t)y * (size_t)*stride;
    for (int x = 0; x < *width; x++) {
      uint32_t sx = xs[x], wx = weights[x],
               nx = sx + 1 < source_width ? sx + 1 : sx;
      for (int channel = 0; channel < 3; channel++) {
        uint32_t top =
            a[sx * 4 + channel] * (256 - wx) + a[nx * 4 + channel] * wx;
        uint32_t bottom =
            b[sx * 4 + channel] * (256 - wx) + b[nx * 4 + channel] * wx;
        dest[x * 4 + channel] =
            (unsigned char)((top * (256 - wy) + bottom * wy + 32768) >> 16);
      }
      dest[x * 4 + 3] = 255;
    }
  }
  return *scratch;
}
#endif
