/* X11 root-window capture. GetImage never contains the pointer, so the video
 * is cursor-free; XFIXES reports the pointer's image, hotspot, position and
 * cursor-theme name separately. Uses the logged-in desktop's authenticated X
 * connection: no listening socket, xhost change, root access or input. */
#include "cursor_shape.h"
#include "encode.h"
#include <X11/Xlib.h>
#include <errno.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xfixes.h>
#ifdef CINDY_XCOMPOSITE
#include <X11/Xatom.h>
#include <X11/extensions/Xcomposite.h>
#endif
#ifdef CINDY_XSHM
#include <X11/extensions/XShm.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#endif

#define X11_EXCLUDED_MAX 4
#define X11_HISTORY 2
struct x11_rect {
  int x, y, width, height;
};
struct x11_capture {
  Display *display;
  Window root;
  Visual *visual;
  int depth, bgrx, x, y, width, height, error, shm_attached;
  /* The persistent SHM image, or the latest XGetImage result. */
  XImage *image;
#ifdef CINDY_XSHM
  XShmSegmentInfo shm;
#endif
  double scale;
  unsigned long cursor_serial;
  int cursor_ready, cursor_opaque, cursor_x, cursor_y, cursor_width,
      cursor_height, hot_x, hot_y;
  char *cursor_png;
  const char *cursor_shape;
  /* Local-only windows (Cindy's on-screen notice) never reach the picture. */
  Window excluded[X11_EXCLUDED_MAX];
  int excluded_count;
  struct x11_rect history[X11_HISTORY][X11_EXCLUDED_MAX];
};
static struct x11_capture xc;
static int x11_error(Display *display, XErrorEvent *event) {
  (void)display;
  (void)event;
  xc.error = 1;
  return 0;
}
/* A Wayland session with DISPLAY set is XWayland: its root holds no desktop. */
static int x11_session_allowed(void) {
  const char *session = getenv("XDG_SESSION_TYPE");
  const char *wayland = getenv("WAYLAND_DISPLAY");
  const char *display = getenv("DISPLAY");
  return display && *display && !(wayland && *wayland) &&
         !(session && !strcmp(session, "wayland"));
}
static void x11_release_image(void) {
  if (!xc.image)
    return;
#ifdef CINDY_XSHM
  if (xc.shm_attached) {
    XShmDetach(xc.display, &xc.shm);
    xc.image->data = NULL;
    shmdt(xc.shm.shmaddr);
    xc.shm_attached = 0;
  }
#endif
  XDestroyImage(xc.image);
  xc.image = NULL;
}
static void x11_close(void) {
  if (xc.display) {
    x11_release_image();
    XCloseDisplay(xc.display);
  }
  free(xc.cursor_png);
  memset(&xc, 0, sizeof(xc));
}
static int x11_geometry(const char *text, int root_width, int root_height) {
  int values[4], used = -1;
  if (!text ||
      sscanf(text, "%d,%d,%d,%d%n", &values[0], &values[1], &values[2],
             &values[3], &used) != 4 ||
      used < 0 || text[used])
    return -1;
  if (values[0] < 0 || values[1] < 0 || values[2] <= 0 || values[3] <= 0 ||
      values[2] > 8192 || values[3] > 8192 ||
      (int64_t)values[2] * values[3] > 16777216 ||
      values[0] > root_width - values[2] || values[1] > root_height - values[3])
    return -1;
  xc.x = values[0];
  xc.y = values[1];
  xc.width = values[2];
  xc.height = values[3];
  return 0;
}
/* Shared memory avoids copying every frame through the X socket. A server in
 * another IPC namespace rejects the attach; ordinary GetImage still works, and
 * is the only path when built without libXext headers. */
static void x11_attach_shm(void) {
#ifdef CINDY_XSHM
  if (!XShmQueryExtension(xc.display))
    return;
  XImage *image = XShmCreateImage(xc.display, xc.visual, (unsigned)xc.depth,
                                  ZPixmap, NULL, &xc.shm, (unsigned)xc.width,
                                  (unsigned)xc.height);
  if (!image)
    return;
  size_t size = (size_t)image->bytes_per_line * (size_t)image->height;
  xc.shm.shmid = shmget(IPC_PRIVATE, size, IPC_CREAT | 0600);
  if (xc.shm.shmid < 0) {
    XDestroyImage(image);
    return;
  }
  xc.shm.shmaddr = shmat(xc.shm.shmid, NULL, 0);
  if (xc.shm.shmaddr == (char *)-1) {
    shmctl(xc.shm.shmid, IPC_RMID, NULL);
    XDestroyImage(image);
    return;
  }
  image->data = xc.shm.shmaddr;
  xc.shm.readOnly = False;
  xc.error = 0;
  XShmAttach(xc.display, &xc.shm);
  XSync(xc.display, False);
  /* The segment disappears once both sides detach, including on SIGKILL. */
  shmctl(xc.shm.shmid, IPC_RMID, NULL);
  if (xc.error) {
    image->data = NULL;
    XDestroyImage(image);
    shmdt(xc.shm.shmaddr);
    xc.error = 0;
    return;
  }
  xc.image = image;
  xc.shm_attached = 1;
#endif
}
/* NULL geometry only probes the display, visual and XFIXES version. */
static int x11_open(const char *geometry) {
  if (!x11_session_allowed())
    return -1;
  xc.display = XOpenDisplay(NULL);
  if (!xc.display)
    return -1;
  XSetErrorHandler(x11_error);
  int screen = DefaultScreen(xc.display);
  xc.root = RootWindow(xc.display, screen);
  xc.visual = DefaultVisual(xc.display, screen);
  xc.depth = DefaultDepth(xc.display, screen);
  int event, error, major = 0, minor = 0;
  if (!XFixesQueryExtension(xc.display, &event, &error) ||
      !XFixesQueryVersion(xc.display, &major, &minor) || major < 2)
    return -1;
  if ((xc.depth != 24 && xc.depth != 32) ||
      ImageByteOrder(xc.display) != LSBFirst)
    return -1;
  if (xc.visual->red_mask == 0xff0000 && xc.visual->green_mask == 0xff00 &&
      xc.visual->blue_mask == 0xff)
    xc.bgrx = 1;
  else if (xc.visual->red_mask == 0xff && xc.visual->green_mask == 0xff00 &&
           xc.visual->blue_mask == 0xff0000)
    xc.bgrx = 0;
  else
    return -1;
  if (!geometry)
    return 0;
  if (x11_geometry(geometry, DisplayWidth(xc.display, screen),
                   DisplayHeight(xc.display, screen)))
    return -1;
  x11_attach_shm();
  return 0;
}
static int x11_frame(void) {
  xc.error = 0;
#ifdef CINDY_XSHM
  if (xc.shm_attached) {
    if (!XShmGetImage(xc.display, xc.root, xc.image, xc.x, xc.y, AllPlanes) ||
        xc.error)
      return -1;
  } else
#endif
  {
    if (xc.image)
      XDestroyImage(xc.image);
    /* A shrunken root (resolution change) fails here; the parent then
     * restarts capture with fresh geometry. */
    xc.image = XGetImage(xc.display, xc.root, xc.x, xc.y, (unsigned)xc.width,
                         (unsigned)xc.height, AllPlanes, ZPixmap);
    if (!xc.image || xc.error)
      return -1;
  }
  return xc.image->bits_per_pixel == 32 &&
                 xc.image->bytes_per_line >= xc.width * 4 &&
                 xc.image->width == xc.width && xc.image->height == xc.height
             ? 0
             : -1;
}
/* XFIXES pixels are premultiplied ARGB in the low 32 bits of each long. */
static char *x11_cursor_png(const unsigned long *pixels, int width, int height,
                            int *opaque) {
  size_t count = (size_t)width * (size_t)height;
  unsigned char *rgba = malloc(count * 4);
  if (!rgba)
    return NULL;
  *opaque = 0;
  for (size_t i = 0; i < count; i++) {
    uint32_t p = (uint32_t)pixels[i], a = p >> 24;
    if (a)
      *opaque = 1;
    rgba[i * 4] = cindy_unpremultiply((p >> 16) & 255, a);
    rgba[i * 4 + 1] = cindy_unpremultiply((p >> 8) & 255, a);
    rgba[i * 4 + 2] = cindy_unpremultiply(p & 255, a);
    rgba[i * 4 + 3] = (unsigned char)a;
  }
  char *result = cindy_png_base64(rgba, width, height);
  free(rgba);
  return result;
}
/* One round trip per frame; the raster is re-encoded only when it changes. */
static void x11_cursor(void) {
  XFixesCursorImage *image = XFixesGetCursorImage(xc.display);
  if (!image) {
    xc.cursor_ready = 0;
    return;
  }
  xc.cursor_x = image->x;
  xc.cursor_y = image->y;
  if (!xc.cursor_ready || image->cursor_serial != xc.cursor_serial) {
    xc.cursor_ready = 0;
    free(xc.cursor_png);
    xc.cursor_png = NULL;
    if (image->width > 0 && image->height > 0 && image->width <= 256 &&
        image->height <= 256 && image->xhot <= image->width &&
        image->yhot <= image->height)
      xc.cursor_png = x11_cursor_png(image->pixels, image->width,
                                     image->height, &xc.cursor_opaque);
    if (xc.cursor_png) {
      xc.cursor_serial = image->cursor_serial;
      xc.cursor_width = image->width;
      xc.cursor_height = image->height;
      xc.hot_x = image->xhot;
      xc.hot_y = image->yhot;
      xc.cursor_shape = cursor_shape_for_name(image->name);
      xc.cursor_ready = 1;
    }
  }
  XFree(image);
}
static void x11_cursor_json(void) {
  if (!xc.cursor_ready || !xc.cursor_png) {
    fputs("null", stdout);
    return;
  }
  double scale = xc.scale > 0 ? xc.scale : 1;
  int dx = xc.cursor_x - xc.x, dy = xc.cursor_y - xc.y;
  int inside = dx >= 0 && dy >= 0 && dx < xc.width && dy < xc.height;
  /* Inverse of the input helper's x * (width - 1) mapping. */
  double nx = xc.width > 1 ? (double)dx / (xc.width - 1) : 0;
  double ny = xc.height > 1 ? (double)dy / (xc.height - 1) : 0;
  /* A fully transparent raster is how X applications hide the pointer. */
  printf("{\"visible\":%s,\"x\":%.6f,\"y\":%.6f,\"width\":%.3f,"
         "\"height\":%.3f,\"hotX\":%.3f,\"hotY\":%.3f,\"png\":\"%s\"",
         inside && xc.cursor_opaque ? "true" : "false", fmax(0, fmin(1, nx)),
         fmax(0, fmin(1, ny)), xc.cursor_width / scale,
         xc.cursor_height / scale, xc.hot_x / scale, xc.hot_y / scale,
         xc.cursor_png);
  if (xc.cursor_shape)
    printf(",\"shape\":\"%s\"", xc.cursor_shape);
  fputc('}', stdout);
}

/* Local-only windows: `exclude:<id>[,<id>...]` names X window IDs (Electron
 * media-source IDs) whose on-screen area is rebuilt from the windows beneath
 * them, so Cindy's controlled notice stays visible locally but never reaches
 * the viewer. Reading obscured window contents needs Composite redirection:
 * an automatic redirect of the root's children is requested for the life of
 * this connection (a compositing manager's manual redirect takes precedence
 * and is left alone); the X server drops it when the helper exits. */
#ifdef CINDY_XCOMPOSITE
static int x11_parse_excluded(const char *text) {
  if (strncmp(text, "exclude:", 8))
    return -1;
  text += 8;
  for (;;) {
    char *end = NULL;
    errno = 0;
    unsigned long id = strtoul(text, &end, 10);
    if (errno || end == text || *text < '1' || *text > '9' || id > 0xffffffffUL ||
        xc.excluded_count >= X11_EXCLUDED_MAX)
      return -1;
    xc.excluded[xc.excluded_count++] = (Window)id;
    if (!*end)
      return 0;
    if (*end != ',')
      return -1;
    text = end + 1;
  }
}
static int x11_composite_ready(void) {
  int event, error, major = 0, minor = 2;
  return XCompositeQueryExtension(xc.display, &event, &error) &&
         XCompositeQueryVersion(xc.display, &major, &minor) &&
         (major > 0 || minor >= 2);
}
static int x11_redirect(void) {
  if (!x11_composite_ready())
    return -1;
  xc.error = 0;
  XCompositeRedirectSubwindows(xc.display, xc.root, CompositeRedirectAutomatic);
  XSync(xc.display, False);
  return xc.error ? -1 : 0;
}
/* The root child holding `window` (its window-manager frame, or itself). */
static Window x11_toplevel(Window window) {
  for (int depth = 0; depth < 32; depth++) {
    Window root, parent, *children = NULL;
    unsigned count = 0;
    if (!XQueryTree(xc.display, window, &root, &parent, &children, &count))
      return None;
    if (children)
      XFree(children);
    if (parent == xc.root)
      return window;
    if (parent == None)
      return None;
    window = parent;
  }
  return None;
}
static struct x11_rect x11_clip(struct x11_rect r) {
  int x0 = r.x > xc.x ? r.x : xc.x, y0 = r.y > xc.y ? r.y : xc.y;
  int x1 = r.x + r.width < xc.x + xc.width ? r.x + r.width : xc.x + xc.width;
  int y1 = r.y + r.height < xc.y + xc.height ? r.y + r.height : xc.y + xc.height;
  struct x11_rect clipped = {x0, y0, x1 - x0, y1 - y0};
  if (clipped.width <= 0 || clipped.height <= 0)
    memset(&clipped, 0, sizeof(clipped));
  return clipped;
}
/* Outer root-relative rectangle of a viewable root child; empty otherwise. */
static struct x11_rect x11_outer(Window window) {
  struct x11_rect r = {0, 0, 0, 0};
  XWindowAttributes a;
  if (window == None || !XGetWindowAttributes(xc.display, window, &a) ||
      a.map_state != IsViewable)
    return r;
  r.x = a.x;
  r.y = a.y;
  r.width = a.width + 2 * a.border_width;
  r.height = a.height + 2 * a.border_width;
  return r;
}
static void x11_locate(Window *top, struct x11_rect *rects) {
  for (int i = 0; i < xc.excluded_count; i++) {
    top[i] = x11_toplevel(xc.excluded[i]);
    rects[i] = x11_clip(x11_outer(top[i]));
  }
}
static int x11_same_format(const Visual *visual) {
  return visual->red_mask == xc.visual->red_mask &&
         visual->green_mask == xc.visual->green_mask &&
         visual->blue_mask == xc.visual->blue_mask;
}
/* Copies (depth 24) or blends premultiplied ARGB (depth 32) over `canvas`. */
static void x11_compose(uint32_t *canvas, struct x11_rect r, XImage *image,
                        int dx, int dy, int alpha) {
  for (int y = 0; y < image->height; y++) {
    const uint32_t *src =
        (const uint32_t *)(image->data + (size_t)y * image->bytes_per_line);
    uint32_t *dst = canvas + (size_t)(dy + y) * r.width + dx;
    for (int x = 0; x < image->width; x++) {
      uint32_t s = src[x], a = s >> 24;
      if (!alpha || a == 255) {
        dst[x] = s & 0xffffff;
        continue;
      }
      if (!a)
        continue;
      uint32_t d = dst[x], out = 0;
      for (int shift = 0; shift <= 16; shift += 8) {
        uint32_t value = ((s >> shift) & 255) + ((d >> shift) & 255) * (255 - a) / 255;
        out |= (value > 255 ? 255 : value) << shift;
      }
      dst[x] = out;
    }
  }
}
/* Repaints `r` (root coordinates, inside the capture) from the desktop
 * background and every viewable root child except `skip`, bottom to top.
 * Anything that cannot be read stays black: never the local-only window. */
static void x11_rebuild(struct x11_rect r, const Window *skip, int skip_count) {
  uint32_t *canvas = calloc((size_t)r.width * (size_t)r.height, 4);
  if (canvas) {
    Atom atom = XInternAtom(xc.display, "_XROOTPMAP_ID", True);
    Atom type;
    int format;
    unsigned long count, after;
    unsigned char *data = NULL;
    if (atom != None &&
        XGetWindowProperty(xc.display, xc.root, atom, 0, 1, False, XA_PIXMAP,
                           &type, &format, &count, &after, &data) == Success &&
        data && type == XA_PIXMAP && format == 32 && count == 1) {
      XImage *image = XGetImage(xc.display, (Pixmap)((unsigned long *)data)[0],
                                r.x, r.y, (unsigned)r.width, (unsigned)r.height,
                                AllPlanes, ZPixmap);
      if (image && image->bits_per_pixel == 32 && image->width == r.width &&
          image->height == r.height)
        x11_compose(canvas, r, image, 0, 0, 0);
      if (image)
        XDestroyImage(image);
    }
    if (data)
      XFree(data);
    Window root, parent, *children = NULL;
    unsigned n = 0;
    if (XQueryTree(xc.display, xc.root, &root, &parent, &children, &n)) {
      for (unsigned i = 0; i < n; i++) {
        int skipped = 0;
        for (int j = 0; j < skip_count; j++)
          skipped |= children[i] == skip[j];
        XWindowAttributes a;
        if (skipped || !XGetWindowAttributes(xc.display, children[i], &a) ||
            a.map_state != IsViewable || a.class != InputOutput ||
            (a.depth != 24 && a.depth != 32) || !x11_same_format(a.visual))
          continue;
        struct x11_rect inner = {a.x + a.border_width, a.y + a.border_width,
                                 a.width, a.height};
        int x0 = inner.x > r.x ? inner.x : r.x, y0 = inner.y > r.y ? inner.y : r.y;
        int x1 = inner.x + inner.width < r.x + r.width ? inner.x + inner.width
                                                        : r.x + r.width;
        int y1 = inner.y + inner.height < r.y + r.height ? inner.y + inner.height
                                                          : r.y + r.height;
        if (x1 <= x0 || y1 <= y0)
          continue;
        /* Redirected windows answer from their own storage, obscured or not. */
        XImage *image = XGetImage(xc.display, children[i], x0 - inner.x,
                                  y0 - inner.y, (unsigned)(x1 - x0),
                                  (unsigned)(y1 - y0), AllPlanes, ZPixmap);
        if (image && image->bits_per_pixel == 32 && image->width == x1 - x0 &&
            image->height == y1 - y0)
          x11_compose(canvas, r, image, x0 - r.x, y0 - r.y, a.depth == 32);
        if (image)
          XDestroyImage(image);
      }
      if (children)
        XFree(children);
    }
  }
  for (int y = 0; y < r.height; y++) {
    uint32_t *dst = (uint32_t *)(xc.image->data +
                                 (size_t)(r.y - xc.y + y) * xc.image->bytes_per_line) +
                    (r.x - xc.x);
    if (canvas)
      memcpy(dst, canvas + (size_t)y * r.width, (size_t)r.width * 4);
    else
      memset(dst, 0, (size_t)r.width * 4);
  }
  free(canvas);
  xc.error = 0;
}
static struct x11_rect x11_bounds(struct x11_rect a, struct x11_rect b) {
  if (!a.width)
    return b;
  if (!b.width)
    return a;
  int x0 = a.x < b.x ? a.x : b.x, y0 = a.y < b.y ? a.y : b.y;
  int x1 = a.x + a.width > b.x + b.width ? a.x + a.width : b.x + b.width;
  int y1 = a.y + a.height > b.y + b.height ? a.y + a.height : b.y + b.height;
  struct x11_rect r = {x0, y0, x1 - x0, y1 - y0};
  return r;
}
/* One frame with local-only windows removed. The compositor may show a moved
 * window where it was a moment ago, so each window's area is the bounding box
 * of where it was before and after this capture and in the previous frames. */
static int x11_frame_local(void) {
  if (!xc.excluded_count)
    return x11_frame();
  Window top[X11_EXCLUDED_MAX];
  struct x11_rect before[X11_EXCLUDED_MAX], after[X11_EXCLUDED_MAX];
  x11_locate(top, before);
  if (x11_frame())
    return -1;
  x11_locate(top, after);
  for (int i = 0; i < xc.excluded_count; i++) {
    struct x11_rect area = x11_bounds(before[i], after[i]);
    for (int h = 0; h < X11_HISTORY; h++)
      area = x11_bounds(area, xc.history[h][i]);
    if (area.width)
      x11_rebuild(area, top, xc.excluded_count);
  }
  memmove(xc.history[1], xc.history[0], sizeof(xc.history[0]) * (X11_HISTORY - 1));
  for (int i = 0; i < xc.excluded_count; i++)
    xc.history[0][i] = after[i];
  return 0;
}
#endif
