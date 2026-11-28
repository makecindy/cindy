/* XTest uses the authenticated X connection of the logged-in desktop. No
 * listening socket, root access, xhost changes or input logging. The parent's
 * lease/ownership checks and this helper's heartbeat apply to both backends. */
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XTest.h>
#include <limits.h>
#include <X11/keysym.h>

static Display *xdisplay;
static int xorigin, yorigin, xwidth, xheight;
static double xwheel, ywheel;
static bool x11_open(char **geometry) {
  /* Do not use XWayland to circumvent a compositor's input permissions. */
  const char *session = getenv("XDG_SESSION_TYPE");
  const char *wayland = getenv("WAYLAND_DISPLAY");
  if ((wayland && *wayland) || (session && !strcmp(session, "wayland")))
    return false;
  xdisplay = XOpenDisplay(NULL);
  if (!xdisplay) return false;
  int event, error, major, minor;
  if (!XTestQueryExtension(xdisplay, &event, &error, &major, &minor)) return false;
  if (!geometry) return true; /* capability probe never injects or remaps */
  int *values[] = {&xorigin, &yorigin, &xwidth, &xheight};
  for (int i = 0; i < 4; i++) {
    char *end;
    errno = 0;
    long value = strtol(geometry[i], &end, 10);
    if (errno || !*geometry[i] || *end || value < 0 || value > 32767) return false;
    *values[i] = (int)value;
  }
  return xwidth > 0 && xheight > 0 &&
    xorigin + xwidth <= DisplayWidth(xdisplay, DefaultScreen(xdisplay)) &&
    yorigin + xheight <= DisplayHeight(xdisplay, DefaultScreen(xdisplay));
}
static void x11_key(uint32_t code, bool down) {
  /* Linux Xorg's evdev keycodes are kernel codes + the reserved X offset. */
  if (code + 8 <= 255) XTestFakeKeyEvent(xdisplay, code + 8, down, CurrentTime);
}
static void x11_move(double x, double y) {
  XTestFakeMotionEvent(xdisplay, DefaultScreen(xdisplay),
    xorigin + (int)llround(x * (xwidth - 1)),
    yorigin + (int)llround(y * (xheight - 1)), CurrentTime);
}
static void x11_button(int button, bool down) {
  XTestFakeButtonEvent(xdisplay, (unsigned)button + 1, down, CurrentTime);
}
static void x11_wheel(double *remainder, double delta, unsigned negative, unsigned positive) {
  *remainder += delta;
  while (fabs(*remainder) >= 40) {
    unsigned button = *remainder < 0 ? negative : positive;
    XTestFakeButtonEvent(xdisplay, button, True, CurrentTime);
    XTestFakeButtonEvent(xdisplay, button, False, CurrentTime);
    *remainder += *remainder < 0 ? 40 : -40;
  }
}
static void x11_scroll(double dx, double dy) {
  x11_wheel(&xwheel, dx, 6, 7);
  x11_wheel(&ywheel, dy, 4, 5);
}
#include "x11-text.h"
