/* X11 key events contain a keycode, not a keysym snapshot. A server roundtrip
 * cannot make a temporary mapping safe to reuse: the receiving application
 * must first have translated the event. Keep ordinary layout keys unchanged;
 * fence remapped keys with the focused client's ordered EWMH ping reply. */
static bool x11_text_failed;
static int x11_text_error(Display *connection, XErrorEvent *error) {
  (void)connection;
  (void)error;
  x11_text_failed = true;
  return 0;
}
static uint64_t x11_text_millis(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
static Window x11_text_target(Atom ping) {
  Window focus;
  int revert;
  XGetInputFocus(xdisplay, &focus, &revert);
  /* Focus is often a toolkit child; its ancestor owns WM_PROTOCOLS. */
  for (int depth = 0; depth < 64 && focus > PointerRoot; depth++) {
    Atom *protocols = NULL;
    int count = 0;
    bool supported = false;
    if (XGetWMProtocols(xdisplay, focus, &protocols, &count))
      for (int i = 0; i < count; i++)
        if (protocols[i] == ping) supported = true;
    if (protocols) XFree(protocols);
    if (supported) return focus;
    Window root, parent, *children = NULL;
    unsigned n;
    Status ok = XQueryTree(xdisplay, focus, &root, &parent, &children, &n);
    if (children) XFree(children);
    if (!ok || focus == root) break;
    focus = parent;
  }
  return None;
}
static bool x11_text_ping(Window target, Atom protocols, Atom ping) {
  static uint32_t sequence;
  Window root = XDefaultRootWindow(xdisplay);
  XEvent request = {0};
  request.xclient.type = ClientMessage;
  request.xclient.window = target;
  request.xclient.message_type = protocols;
  request.xclient.format = 32;
  request.xclient.data.l[0] = (long)ping;
  request.xclient.data.l[1] = ++sequence;
  request.xclient.data.l[2] = (long)target;
  if (!XSendEvent(xdisplay, target, False, NoEventMask, &request)) return false;
  XFlush(xdisplay);
  uint64_t deadline = x11_text_millis() + 2000;
  while (!stopping && !x11_text_failed && x11_text_millis() < deadline) {
    while (XPending(xdisplay)) {
      XEvent reply;
      XNextEvent(xdisplay, &reply);
      if (reply.type == ClientMessage && reply.xclient.window == root &&
          reply.xclient.message_type == protocols && reply.xclient.format == 32 &&
          reply.xclient.data.l[0] == (long)ping &&
          reply.xclient.data.l[1] == request.xclient.data.l[1] &&
          reply.xclient.data.l[2] == (long)target)
        return true;
    }
    struct pollfd fd = {XConnectionNumber(xdisplay), POLLIN, 0};
    int result = poll(&fd, 1, 20);
    if ((result < 0 && errno != EINTR) || (fd.revents & (POLLERR | POLLHUP | POLLNVAL)))
      return false;
  }
  return false;
}
static bool x11_text_plan(const char *text, bool apply) {
  struct {
    KeySym symbol;
    KeyCode code;
    bool shift;
    bool level3;
  } plan[4096];
  size_t count = 0;
  bool ok = false, changed = false, needs_mapping = false;
  int min, max, per = 0, spare = 0;
  KeySym *map = NULL, *symbols = NULL;
  XkbDescPtr layout = NULL;
  XkbStateRec state;
  XSync(xdisplay, False);
  x11_text_failed = false;
  XErrorHandler previous = XSetErrorHandler(x11_text_error);
  XDisplayKeycodes(xdisplay, &min, &max);
  layout = XkbGetMap(xdisplay, XkbAllClientInfoMask, XkbUseCoreKbd);
  if (!layout || XkbGetState(xdisplay, XkbUseCoreKbd, &state) != Success)
    goto cleanup;
  /* Never turn a local user's held Ctrl/Alt/etc into text shortcuts, or release
   * their keys. Caps/Num Lock are handled by XKB's actual translation below. */
  if (state.mods & ~(LockMask | Mod2Mask)) goto cleanup;
  /* Use the layout's actual level selector, never Ctrl+Alt as an AltGr
   * shortcut approximation. Do not synthesize ordinary shortcut modifiers. */
  KeyCode level3 = XKeysymToKeycode(xdisplay, XK_ISO_Level3_Shift);
  unsigned level3_mask = level3 ? XkbKeysymToModifiers(xdisplay, XK_ISO_Level3_Shift) : 0;
  if (level3_mask & (ShiftMask | LockMask | ControlMask | Mod1Mask | Mod2Mask | Mod4Mask))
    level3_mask = 0;
  const unsigned char *p = (const unsigned char *)text;
  while (*p) {
    if (count == 4096) goto cleanup;
    uint32_t c = *p++;
    int rest = c < 0x80 ? 0 : c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
    if (rest) c &= (1u << (6 - rest)) - 1;
    while (rest--) c = (c << 6) | (*p++ & 63);
    KeySym symbol = c == '\n' || c == '\r' ? 0xff0d : c == '\t' ? 0xff09 :
      c < 256 ? c : 0x01000000u | c;
    plan[count].symbol = symbol;
    plan[count].code = 0;
    // Search every selector state for ordinary exact symbols before accepting
    // Unicode equivalents. Keypad symbols can send terminal application escapes.
    for (int preference = 0; preference < 3 && !plan[count].code; preference++)
    for (int selectors = 0; selectors < 4 && !plan[count].code; selectors++) {
      if ((selectors & 2) && !level3_mask) continue;
      for (int k = min; k <= max; k++) {
        KeySym translated;
        unsigned consumed;
        unsigned mods = XkbBuildCoreState(state.mods |
          ((selectors & 1) ? ShiftMask : 0) | ((selectors & 2) ? level3_mask : 0), state.group);
        if (!XkbTranslateKeyCode(layout, (KeyCode)k, mods, &consumed, &translated)) continue;
        bool keypad = translated >= XK_KP_Space && translated <= XK_KP_Equal;
        bool matches = preference == 0 ? !keypad && translated == symbol :
          (preference == 1 ? !keypad : keypad) && xkb_keysym_to_utf32((uint32_t)translated) == c;
        if (matches) {
          plan[count].code = (KeyCode)k;
          plan[count].shift = (selectors & 1) != 0;
          plan[count].level3 = (selectors & 2) != 0;
          break;
        }
      }
    }
    if (!plan[count].code) needs_mapping = true;
    count++;
  }
  KeyCode shift = XKeysymToKeycode(xdisplay, XK_Shift_L);
  for (size_t i = 0; i < count; i++)
    if (plan[i].code && plan[i].shift && !shift) goto cleanup;
  Atom protocols = None, ping = None;
  if (needs_mapping) {
    protocols = XInternAtom(xdisplay, "WM_PROTOCOLS", False);
    ping = XInternAtom(xdisplay, "_NET_WM_PING", False);
    Window target = x11_text_target(ping);
    if (!target) goto cleanup; /* refuse before injecting any part of this text */
    XSelectInput(xdisplay, XDefaultRootWindow(xdisplay), SubstructureNotifyMask);
    if (!x11_text_ping(target, protocols, ping)) goto cleanup;
    map = XGetKeyboardMapping(xdisplay, min, max - min + 1, &per);
    if (!map || per <= 0) goto cleanup;
    char held[32];
    XQueryKeymap(xdisplay, held);
    for (int k = max; k >= min && !spare; k--) {
      bool empty = !(held[k / 8] & (1 << (k % 8)));
      for (int j = 0; j < per; j++)
        if (map[(k - min) * per + j] != NoSymbol) empty = false;
      if (empty) spare = k;
    }
    if (!spare || !(symbols = calloc((size_t)per, sizeof(KeySym)))) goto cleanup;
  }
  if (!apply) {
    ok = !stopping && !x11_text_failed;
    goto cleanup;
  }
  for (size_t i = 0; i < count && !stopping && !x11_text_failed; i++) {
    if (plan[i].code) {
      if (plan[i].level3) XTestFakeKeyEvent(xdisplay, level3, True, CurrentTime);
      if (plan[i].shift) XTestFakeKeyEvent(xdisplay, shift, True, CurrentTime);
      XTestFakeKeyEvent(xdisplay, plan[i].code, True, 10);
      XTestFakeKeyEvent(xdisplay, plan[i].code, False, 10);
      if (plan[i].shift) XTestFakeKeyEvent(xdisplay, shift, False, CurrentTime);
      if (plan[i].level3) XTestFakeKeyEvent(xdisplay, level3, False, CurrentTime);
      XSync(xdisplay, False);
    } else {
      /* Do not let another client change focus between selecting the receiver
       * and posting this key plus its fence. Release the server before waiting
       * so the receiver can fetch the mapping and reply. */
      XGrabServer(xdisplay);
      Window target = x11_text_target(ping);
      if (target && !x11_text_failed) {
        for (int j = 0; j < per; j++) symbols[j] = plan[i].symbol;
        XChangeKeyboardMapping(xdisplay, spare, per, symbols, 1);
        changed = true;
        XTestFakeKeyEvent(xdisplay, spare, True, 10);
        XTestFakeKeyEvent(xdisplay, spare, False, 10);
      }
      XUngrabServer(xdisplay);
      if (!target || !x11_text_ping(target, protocols, ping)) goto cleanup;
      /* The client has translated this key before its ordered ping reply.
       * Only now may the next character reuse the temporary keycode. */
    }
  }
  ok = !stopping && !x11_text_failed;
cleanup:
  if (changed)
    XChangeKeyboardMapping(xdisplay, spare, per, map + (spare - min) * per, 1);
  if (needs_mapping) XSelectInput(xdisplay, XDefaultRootWindow(xdisplay), NoEventMask);
  XSync(xdisplay, False);
  ok = ok && !x11_text_failed;
  XSetErrorHandler(previous);
  if (layout) XkbFreeKeyboard(layout, XkbAllComponentsMask, True);
  if (map) XFree(map);
  free(symbols);
  return ok;
}
static bool x11_text(const char *text) { return x11_text_plan(text, true); }
static bool x11_text_check(const char *text) { return x11_text_plan(text, false); }
