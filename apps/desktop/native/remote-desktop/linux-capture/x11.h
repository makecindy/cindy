/* X11 root-window capture. GetImage never contains the pointer, so the video
 * is cursor-free; XFIXES reports the pointer's image, hotspot, position and
 * cursor-theme name separately. Uses the logged-in desktop's authenticated X
 * connection: no listening socket, xhost change, root access or input. */
#include "cursor_shape.h"
#include "encode.h"
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xfixes.h>
#ifdef CINDY_XSHM
#include <X11/extensions/XShm.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#endif

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
