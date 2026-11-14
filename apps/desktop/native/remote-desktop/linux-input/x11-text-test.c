/* Production x11_text entry with an in-memory X client/server transport.
 * The receiver translates keycodes only after a delayed, ordered ping fence.
 * Unlike x11-test.py's prompt event consumer, this deterministically catches
 * reuse/restoration before consumption, without a real display or sleeps. */
#define _POSIX_C_SOURCE 200809L
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/keysym.h>
#include <assert.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static Display *xdisplay;
static volatile sig_atomic_t stopping;
static uint64_t elapsed;
static KeySym mapping[256], original[256], received[4096];
static struct { unsigned code; bool shift, level3; } pending[4096];
static size_t pending_count, received_count;
static XkbDescRec layout;
static unsigned mods;
static bool shifted, supports_ping, dropped, interrupt_wait, destroy_target;
static bool level3_down, has_level3;
static int changes, pings, drop_after, bad_replies;
static XErrorHandler error_handler;
static XEvent ping_request;
static uint64_t consume_after;

static void consume(void) {
  for (size_t i = 0; i < pending_count; i++) {
    KeySym sym = mapping[pending[i].code];
    if (sym == 'a' && (pending[i].shift != !!(mods & LockMask))) sym = 'A';
    if (pending[i].code == 21 && pending[i].shift) sym = '+';
    if (pending[i].code == 22 && pending[i].shift) sym = '*';
    if (pending[i].code == 24 && pending[i].level3)
      sym = pending[i].shift ? XK_Greek_OMEGA : '@';
    received[received_count++] = sym;
  }
  pending_count = 0;
}
static int fake_clock_gettime(clockid_t clock, struct timespec *t) {
  (void)clock;
  t->tv_sec = (time_t)(elapsed / 1000);
  t->tv_nsec = (long)(elapsed % 1000) * 1000000;
  return 0;
}
static int fake_poll(struct pollfd *fds, nfds_t n, int timeout) {
  (void)fds;
  (void)n;
  elapsed += (uint64_t)timeout;
  if (interrupt_wait && pings >= 2) stopping = 1;
  return 0;
}
#define clock_gettime fake_clock_gettime
#define poll fake_poll
int XTestFakeKeyEvent(Display *, unsigned, Bool, unsigned long);
uint32_t xkb_keysym_to_utf32(uint32_t);
#include "x11-text.h"

/* Fake the external conversion API; real libxkbcommon/layouts are exercised
 * separately by the private-Xvfb integration, not by copied production code. */
uint32_t xkb_keysym_to_utf32(uint32_t symbol) {
  switch (symbol) {
    case XK_Cyrillic_a: return 0x430;
    case XK_Greek_alpha: return 0x3b1;
    case XK_Greek_OMEGA: return 0x3a9;
    case XK_Arabic_sheen: return 0x634;
    case XK_hebrew_aleph: return 0x5d0;
    case XK_KP_Add: return '+';
    case XK_KP_Multiply: return '*';
    default: return symbol < 256 ? symbol : (symbol & 0xff000000) == 0x01000000 ? symbol & 0xffffff : 0;
  }
}

int XSync(Display *d, Bool discard) { (void)d; (void)discard; return 0; }
XErrorHandler XSetErrorHandler(XErrorHandler handler) {
  XErrorHandler old = error_handler;
  error_handler = handler;
  return old;
}
int XDisplayKeycodes(Display *d, int *min, int *max) {
  (void)d; *min = 8; *max = 255; return 1;
}
XkbDescPtr XkbGetMap(Display *d, unsigned which, unsigned device) {
  (void)d; (void)which; (void)device; return &layout;
}
Status XkbGetState(Display *d, unsigned device, XkbStatePtr state) {
  (void)d; (void)device; memset(state, 0, sizeof(*state)); state->mods = mods; return Success;
}
Bool XkbTranslateKeyCode(XkbDescPtr keys, KeyCode code, unsigned state,
                         unsigned *consumed, KeySym *symbol) {
  (void)keys; *consumed = 0; *symbol = mapping[code];
  if (*symbol == 'a' && (!!(state & ShiftMask) != !!(state & LockMask))) *symbol = 'A';
  if (code == 21 && (state & ShiftMask)) *symbol = '+';
  if (code == 22 && (state & ShiftMask)) *symbol = '*';
  if (code == 24 && (state & Mod5Mask))
    *symbol = (state & ShiftMask) ? XK_Greek_OMEGA : '@';
  return *symbol != NoSymbol;
}
KeyCode XKeysymToKeycode(Display *d, KeySym symbol) {
  (void)d;
  return symbol == XK_Shift_L ? 50 : symbol == XK_ISO_Level3_Shift && has_level3 ? 108 : 0;
}
unsigned XkbKeysymToModifiers(Display *d, KeySym symbol) {
  (void)d; return symbol == XK_ISO_Level3_Shift && has_level3 ? Mod5Mask : 0;
}
Atom XInternAtom(Display *d, const char *name, Bool only) {
  (void)d; (void)only; return !strcmp(name, "WM_PROTOCOLS") ? 100 : 101;
}
int XGetInputFocus(Display *d, Window *focus, int *revert) {
  (void)d; *focus = 11; *revert = RevertToParent; return 1;
}
Status XGetWMProtocols(Display *d, Window win, Atom **protocols, int *count) {
  (void)d; *protocols = NULL; *count = 0;
  if (win != 10 || !supports_ping) return 0;
  *protocols = malloc(sizeof(Atom)); assert(*protocols);
  **protocols = 101; *count = 1; return 1;
}
Status XQueryTree(Display *d, Window win, Window *root, Window *parent,
                  Window **children, unsigned *n) {
  (void)d; *root = 1; *parent = win == 11 ? 10 : 1; *children = NULL; *n = 0; return 1;
}
int XFree(void *data) { free(data); return 1; }
Window XDefaultRootWindow(Display *d) { (void)d; return 1; }
int XSelectInput(Display *d, Window win, long mask) {
  (void)d; (void)win; (void)mask; return 1;
}
Status XSendEvent(Display *d, Window win, Bool propagate, long mask, XEvent *event) {
  (void)d; (void)win; (void)propagate; (void)mask;
  pings++;
  if (destroy_target && pings >= 2) {
    XErrorEvent error = {0}; error.error_code = BadWindow;
    error_handler(xdisplay, &error);
    return 0;
  }
  ping_request = *event;
  consume_after = elapsed + 200; /* simulated busy receiver: no actual sleep */
  dropped = drop_after && pings >= drop_after;
  return 1;
}
int XFlush(Display *d) { (void)d; return 1; }
int XPending(Display *d) {
  (void)d;
  return ping_request.type && (bad_replies || (!dropped && elapsed >= consume_after));
}
int XNextEvent(Display *d, XEvent *event) {
  (void)d; *event = ping_request; event->xclient.window = 1;
  if (bad_replies) {
    /* Neither a stale serial nor a reply for another receiver is a fence. */
    if (bad_replies-- == 2) event->xclient.data.l[1]--;
    else event->xclient.data.l[2]++;
  } else {
    consume();
    ping_request.type = 0;
  }
  return 1;
}
int XConnectionNumber(Display *d) { (void)d; return -1; }
#if NeedWidePrototypes
typedef unsigned X11FirstKey;
#else
typedef KeyCode X11FirstKey;
#endif
KeySym *XGetKeyboardMapping(Display *d, X11FirstKey first, int count, int *per) {
  (void)d; *per = 1;
  KeySym *copy = malloc((size_t)count * sizeof(KeySym)); assert(copy);
  memcpy(copy, mapping + first, (size_t)count * sizeof(KeySym)); return copy;
}
int XQueryKeymap(Display *d, char held[32]) { (void)d; memset(held, 0, 32); return 1; }
int XChangeKeyboardMapping(Display *d, int first, int per, KeySym *symbols, int count) {
  (void)d; assert(per == 1 && count == 1);
  /* A successful call must not destroy an unconsumed key's meaning. On an
   * explicit error/cancellation, cleanup still has to restore the original map. */
  if (!stopping && !dropped && !destroy_target)
    for (size_t i = 0; i < pending_count; i++) assert(pending[i].code != (unsigned)first);
  mapping[first] = *symbols; changes++; return 1;
}
int XTestFakeKeyEvent(Display *d, unsigned code, Bool down, unsigned long delay) {
  (void)d; (void)delay;
  if (code == 50) shifted = down;
  else if (code == 108) level3_down = down;
  else if (down) {
    assert(pending_count < 4096);
    pending[pending_count].code = code;
    pending[pending_count].shift = shifted;
    pending[pending_count++].level3 = level3_down;
  }
  return 1;
}
int XGrabServer(Display *d) { (void)d; return 1; }
int XUngrabServer(Display *d) { (void)d; return 1; }
void XkbFreeKeyboard(XkbDescPtr keys, unsigned which, Bool all) {
  (void)keys; (void)which; (void)all;
}

static void reset(void) {
  stopping = 0; elapsed = 0; mods = 0; shifted = false;
  level3_down = has_level3 = false;
  supports_ping = true; dropped = interrupt_wait = destroy_target = false;
  changes = pings = drop_after = bad_replies = 0;
  pending_count = received_count = 0; ping_request.type = 0;
  error_handler = NULL;
  memset(mapping, 0, sizeof(mapping));
  mapping[38] = 'a'; mapping[56] = 'b'; mapping[36] = XK_Return;
  mapping[23] = XK_Tab; mapping[50] = XK_Shift_L;
  memcpy(original, mapping, sizeof(mapping));
}
static void restored(void) {
  assert(!memcmp(mapping, original, sizeof(mapping)));
  assert(!shifted && !level3_down && !error_handler);
}
int main(void) {
  reset(); supports_ping = false;
  assert(x11_text("aA\t\n"));
  assert(changes == 0 && pings == 0 && received_count == 0);
  consume();
  assert(received_count == 4 && received[0] == 'a' && received[1] == 'A' &&
         received[2] == XK_Tab && received[3] == XK_Return);
  restored();

  reset(); mods = LockMask;
  assert(x11_text("aA")); consume();
  assert(received[0] == 'a' && received[1] == 'A'); restored();

  reset(); supports_ping = false;
  original[19] = mapping[19] = XK_KP_Multiply;
  original[20] = mapping[20] = XK_KP_Add;
  original[21] = mapping[21] = '=';
  original[22] = mapping[22] = '8';
  assert(x11_text("+*"));
  assert(pending_count == 2 && pending[0].code == 21 && pending[1].code == 22);
  consume(); assert(received[0] == '+' && received[1] == '*'); restored();

  reset(); supports_ping = false;
  assert(x11_text_check("aA"));
  assert(!x11_text_check("a\xe4\xb8\xad"));
  assert(pending_count == 0 && received_count == 0 && changes == 0); restored();
  reset(); assert(x11_text_check("\xe4\xb8\xad"));
  assert(pending_count == 0 && received_count == 0 && changes == 0); restored();

  const struct { KeySym symbol; const char *text; } legacy[] = {
    {XK_Cyrillic_a, "\xd0\xb0"}, {XK_Greek_alpha, "\xce\xb1"},
    {XK_Arabic_sheen, "\xd8\xb4"}, {XK_hebrew_aleph, "\xd7\x90"},
  };
  for (size_t i = 0; i < sizeof(legacy) / sizeof(legacy[0]); i++) {
    reset(); supports_ping = false;
    original[38] = mapping[38] = legacy[i].symbol;
    assert(x11_text(legacy[i].text)); consume();
    assert(received_count == 1 && received[0] == legacy[i].symbol && changes == 0 && pings == 0);
    restored();
  }
  reset(); supports_ping = false; has_level3 = true;
  original[24] = mapping[24] = 'q';
  assert(x11_text("@\xce\xa9")); consume();
  assert(received_count == 2 && received[0] == '@' && received[1] == XK_Greek_OMEGA);
  assert(changes == 0 && pings == 0); restored();

  reset(); bad_replies = 2;
  assert(x11_text("a\xe4\xb8\xad\xf0\x9f\x99\x82" "a\xe4\xb8\xad"));
  consume();
  const KeySym wanted[] = {'a', 0x1004e2d, 0x101f642, 'a', 0x1004e2d};
  assert(received_count == 5 && !memcmp(received, wanted, sizeof(wanted)));
  assert(elapsed >= 800 && changes == 4); restored();

  reset(); supports_ping = false;
  assert(!x11_text("a\xe4\xb8\xad"));
  assert(pending_count == 0 && changes == 0); restored();

  reset(); drop_after = 2;
  assert(!x11_text("\xe4\xb8\xad\xf0\x9f\x99\x82"));
  assert(elapsed >= 2200 && pending_count == 1); restored();

  reset(); interrupt_wait = true;
  assert(!x11_text("\xe4\xb8\xad")); assert(stopping); restored();

  reset(); destroy_target = true;
  assert(!x11_text("\xe4\xb8\xad")); restored();

  reset(); mods = ControlMask;
  assert(!x11_text("a")); assert(pending_count == 0); restored();
  puts("PASS: delayed Unicode consumption, stale/wrong fences, stable layout keys, Caps Lock, unsupported clients, timeout, cancellation, destroyed client and map restoration");
  return 0;
}
