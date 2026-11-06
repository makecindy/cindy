/* XTest uses the authenticated X connection of the logged-in desktop. No
 * listening socket, root access, xhost changes or input logging. The parent's
 * lease/ownership checks and this helper's heartbeat apply to both backends. */
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XTest.h>
#include <limits.h>

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
static bool x11_text(const char *text) {
  /* Reserve an unused, unpressed key only for this commit, restoring the exact
   * mapping before acknowledging. Unlike Ctrl+V this never replaces clipboard
   * contents. All levels carry the same symbol (no synthetic Shift shortcuts). */
  int min, max, per;
  XDisplayKeycodes(xdisplay, &min, &max);
  KeySym *map = XGetKeyboardMapping(xdisplay, min, max - min + 1, &per);
  if (!map) return false;
  char held[32];
  XQueryKeymap(xdisplay, held);
  int spare = 0;
  for (int k = max; k >= min && !spare; k--) {
    bool empty = !(held[k / 8] & (1 << (k % 8)));
    for (int j = 0; j < per; j++)
      if (map[(k - min) * per + j] != NoSymbol) empty = false;
    if (empty) spare = k;
  }
  if (!spare) { XFree(map); return false; }
  KeySym *symbols = calloc((size_t)per, sizeof(KeySym));
  if (!symbols) { XFree(map); return false; }
  const unsigned char *p = (const unsigned char *)text;
  while (*p && !stopping) {
    uint32_t c = *p++;
    int rest = c < 0x80 ? 0 : c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
    if (rest) c &= (1u << (6 - rest)) - 1;
    while (rest--) c = (c << 6) | (*p++ & 63);
    KeySym sym = c == '\n' || c == '\r' ? 0xff0d : c == '\t' ? 0xff09 :
      c < 256 ? c : 0x01000000u | c;
    for (int j = 0; j < per; j++) symbols[j] = sym;
    XChangeKeyboardMapping(xdisplay, spare, per, symbols, 1);
    XSync(xdisplay, False);
    /* Allow clients to consume MappingNotify and each edge before remapping.
     * The main process limits commits to 64 characters on this backend. */
    XTestFakeKeyEvent(xdisplay, spare, True, 10);
    XTestFakeKeyEvent(xdisplay, spare, False, 10);
    XSync(xdisplay, False);
    struct timespec pace = {.tv_nsec = 10000000};
    nanosleep(&pace, NULL);
  }
  XChangeKeyboardMapping(xdisplay, spare, per, map + (spare - min) * per, 1);
  XSync(xdisplay, False);
  free(symbols);
  XFree(map);
  return !stopping;
}
