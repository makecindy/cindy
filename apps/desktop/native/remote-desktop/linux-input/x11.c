#define _GNU_SOURCE
#include "backend.h"
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>
#include <xkbcommon/xkbcommon.h>
#include <linux/input-event-codes.h>
#include <math.h>
#include <string.h>
#include <unistd.h>

// XTEST uses the existing user session only. No keyboard-map writes, child
// processes, grabs, clipboard, commands, input logging or privileged devices.
static Display *display;
static int screen;
static struct geometry area;
static bool keys[256], buttons[3], failed;
static KeyCode physical[256], held_keys[256];
static double scroll_x, scroll_y;
static XkbDescPtr keymap;
static const unsigned int button_numbers[] = {1, 2, 3};
static const unsigned int button_masks[] = {Button1Mask, Button2Mask, Button3Mask};
static int error_handler(Display *d, XErrorEvent *e) {
  (void)d; (void)e;
  failed = true;
  return 0;
}
static int io_error(Display *d) {
  (void)d;
  _exit(2);
}
static bool pressed(KeyCode code) {
  char bits[32];
  XQueryKeymap(display, bits);
  return (bits[code / 8] & (1u << (code % 8))) != 0;
}
static bool refresh_names(void) {
  XkbDescPtr map = XkbGetKeyboard(display, XkbAllComponentsMask, XkbUseCoreKbd);
  if (!map || !map->names || !map->names->keys) {
    if (map) XkbFreeKeyboard(map, XkbAllComponentsMask, True);
    return false;
  }
  memset(physical, 0, sizeof(physical));
  // DOM code -> shared evdev identifier -> server XKB PHYSICAL key name.
  // Numeric X keycodes are deliberately never inferred with evdev + 8.
  static const struct { unsigned int code; const char *name; } names[] = {
    {KEY_A,"AC01"},{KEY_B,"AB05"},{KEY_C,"AB03"},{KEY_D,"AC03"},
    {KEY_E,"AD03"},{KEY_F,"AC04"},{KEY_G,"AC05"},{KEY_H,"AC06"},
    {KEY_I,"AD08"},{KEY_J,"AC07"},{KEY_K,"AC08"},{KEY_L,"AC09"},
    {KEY_M,"AB07"},{KEY_N,"AB06"},{KEY_O,"AD09"},{KEY_P,"AD10"},
    {KEY_Q,"AD01"},{KEY_R,"AD04"},{KEY_S,"AC02"},{KEY_T,"AD05"},
    {KEY_U,"AD07"},{KEY_V,"AB04"},{KEY_W,"AD02"},{KEY_X,"AB02"},
    {KEY_Y,"AD06"},{KEY_Z,"AB01"},
    {KEY_1,"AE01"},{KEY_2,"AE02"},{KEY_3,"AE03"},{KEY_4,"AE04"},
    {KEY_5,"AE05"},{KEY_6,"AE06"},{KEY_7,"AE07"},{KEY_8,"AE08"},
    {KEY_9,"AE09"},{KEY_0,"AE10"},
    {KEY_F1,"FK01"},{KEY_F2,"FK02"},{KEY_F3,"FK03"},{KEY_F4,"FK04"},
    {KEY_F5,"FK05"},{KEY_F6,"FK06"},{KEY_F7,"FK07"},{KEY_F8,"FK08"},
    {KEY_F9,"FK09"},{KEY_F10,"FK10"},{KEY_F11,"FK11"},{KEY_F12,"FK12"},
    {KEY_ENTER,"RTRN"},{KEY_ESC,"ESC"},{KEY_TAB,"TAB"},{KEY_SPACE,"SPCE"},
    {KEY_BACKSPACE,"BKSP"},{KEY_DELETE,"DELE"},{KEY_INSERT,"INS"},
    {KEY_HOME,"HOME"},{KEY_END,"END"},{KEY_PAGEUP,"PGUP"},{KEY_PAGEDOWN,"PGDN"},
    {KEY_UP,"UP"},{KEY_DOWN,"DOWN"},{KEY_LEFT,"LEFT"},{KEY_RIGHT,"RGHT"},
    {KEY_LEFTSHIFT,"LFSH"},{KEY_LEFTCTRL,"LCTL"},{KEY_LEFTALT,"LALT"},
    {KEY_LEFTMETA,"LWIN"},{KEY_MINUS,"AE11"},{KEY_EQUAL,"AE12"},
    {KEY_LEFTBRACE,"AD11"},{KEY_RIGHTBRACE,"AD12"},{KEY_BACKSLASH,"BKSL"},
    {KEY_SEMICOLON,"AC10"},{KEY_APOSTROPHE,"AC11"},{KEY_GRAVE,"TLDE"},
    {KEY_COMMA,"AB08"},{KEY_DOT,"AB09"},{KEY_SLASH,"AB10"}
  };
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++)
    for (int c = map->min_key_code; c <= map->max_key_code; c++)
      if (!strncmp(map->names->keys[c].name, names[i].name, XkbKeyNameLength)) {
        physical[names[i].code] = (KeyCode)c;
        break;
      }
  if (keymap) XkbFreeKeyboard(keymap, XkbAllComponentsMask, True);
  keymap = map;
  return !failed;
}
bool backend_open(bool check, const struct geometry *geometry) {
  display = XOpenDisplay(NULL);
  if (!display) return false;
  XSetErrorHandler(error_handler);
  XSetIOErrorHandler(io_error);
  int opcode, event, error, major, minor;
  if (XQueryExtension(display, "XWAYLAND", &opcode, &event, &error) ||
      !XTestQueryExtension(display, &event, &error, &major, &minor)) return false;
  screen = DefaultScreen(display);
  int width = DisplayWidth(display, screen), height = DisplayHeight(display, screen);
  area = geometry->supplied ? *geometry : (struct geometry){0, 0, width, height, true};
  if (area.x < 0 || area.y < 0 || area.width <= 0 || area.height <= 0 ||
      area.x >= width || area.y >= height || area.width > width - area.x ||
      area.height > height - area.y || area.x + area.width > 32768 ||
      area.y + area.height > 32768) return false;
  // Probe stops before keyboard queries or any XTEST request.
  if (check) return !failed;
  return refresh_names() && backend_sync();
}
int backend_fd(void) { return ConnectionNumber(display); }
bool backend_dispatch(void) {
  if (!backend_sync()) return false;
  while (XPending(display)) {
    XEvent event;
    XNextEvent(display, &event);
    if (event.type == MappingNotify) XRefreshKeyboardMapping(&event.xmapping);
  }
  // NamesNotify is not a core MappingNotify. Re-read both names and the map
  // before every batch, rather than trusting an incomplete event subscription.
  return refresh_names();
}
bool backend_sync(void) { XSync(display, False); return !failed; }
bool backend_key_available(uint32_t code) {
  return code < 256 && (physical[code] || held_keys[code]);
}
bool backend_key(uint32_t code, bool down) {
  // A runtime name/map change must not move a key that we already hold.
  // Match keyup (and repeated keydown) to the KeyCode claimed by keydown.
  KeyCode c = held_keys[code] ? held_keys[code] : physical[code];
  if (!c) return false;
  if (down) {
    if (keys[c] || pressed(c)) return !failed; // Do not claim a user's held key.
    keys[c] = true;
    held_keys[code] = c;
  } else {
    if (!held_keys[code]) return true;
    keys[c] = false;
    held_keys[code] = 0;
  }
  return XTestFakeKeyEvent(display, c, down, CurrentTime) && !failed;
}
bool backend_pointer(double x, double y, int button, bool down) {
  if (!XTestFakeMotionEvent(display, screen,
      area.x + (int)llround(x * (area.width - 1)),
      area.y + (int)llround(y * (area.height - 1)), CurrentTime)) return false;
  if (button >= 0 && buttons[button] != down) {
    if (down) {
      Window root, child; int rx, ry, wx, wy; unsigned int mask;
      if (!XQueryPointer(display, RootWindow(display, screen), &root, &child,
                         &rx, &ry, &wx, &wy, &mask)) return false;
      if (mask & button_masks[button]) return !failed;
    }
    buttons[button] = down;
    if (!XTestFakeButtonEvent(display, button_numbers[button], down, CurrentTime)) return false;
  }
  return !failed;
}
static bool wheel(double *pending, double delta, unsigned int negative, unsigned int positive) {
  // Preserve sub-notch deltas across batches; 120 protocol units = one notch.
  *pending += delta;
  while (fabs(*pending) >= 120 && !stopping) {
    unsigned int button = *pending < 0 ? negative : positive;
    if (!XTestFakeButtonEvent(display, button, True, CurrentTime) ||
        !XTestFakeButtonEvent(display, button, False, CurrentTime)) return false;
    *pending += *pending < 0 ? 120 : -120;
  }
  return !failed && !stopping;
}
bool backend_scroll(double dx, double dy) {
  return wheel(&scroll_x, dx, 6, 7) && wheel(&scroll_y, dy, 4, 5);
}
void backend_release(void) {
  for (int c = 0; c < 256; c++) if (keys[c]) {
    XTestFakeKeyEvent(display, c, False, CurrentTime);
    keys[c] = false;
  }
  for (int b = 0; b < 3; b++) if (buttons[b]) {
    XTestFakeButtonEvent(display, button_numbers[b], False, CurrentTime);
    buttons[b] = false;
  }
  memset(held_keys, 0, sizeof(held_keys));
  scroll_x = scroll_y = 0;
}
// Text is deliberately limited to the current group at level none/Shift.
// A private map snapshot avoids Xlib's stale cached lookup after runtime changes.
struct text_context {
  unsigned int group, locked_mods;
  char held[32];
  bool modifier[256];
  KeyCode shift;
};
static bool text_context(struct text_context *ctx) {
  memset(ctx, 0, sizeof(*ctx));
  XkbStateRec state;
  if (XkbGetState(display, XkbUseCoreKbd, &state) != Success || state.latched_mods)
    return false;
  // Preserve the user's lock state and translate against it. Other locked
  // modifiers may change shortcut semantics, so keep rejecting those.
  unsigned int locks = XkbKeysymToModifiers(display, XK_Caps_Lock) |
                       XkbKeysymToModifiers(display, XK_Num_Lock);
  if (state.locked_mods & ~locks) return false;
  ctx->locked_mods = state.locked_mods;
  ctx->group = state.group;
  XQueryKeymap(display, ctx->held);
  // Preflight against the state after our keys are temporarily released.
  for (int c = 0; c < 256; c++)
    if (keys[c]) ctx->held[c / 8] &= ~(1u << (c % 8));
  XModifierKeymap *mods = XGetModifierMapping(display);
  if (!mods) return false;
  bool ok = true;
  unsigned int owned_mods = 0;
  for (int i = 0; i < 8 * mods->max_keypermod; i++) {
    KeyCode c = mods->modifiermap[i];
    if (!c) continue;
    ctx->modifier[c] = true;
    // Check physical state too, not just the effective modifier mask. Never
    // release or borrow a modifier already held by the local user.
    if (keys[c]) {
      owned_mods |= 1u << (i / mods->max_keypermod);
      ctx->held[c / 8] &= ~(1u << (c % 8));
    } else if (ctx->held[c / 8] & (1u << (c % 8))) ok = false;
    if (i < mods->max_keypermod && !ctx->shift) ctx->shift = c;
  }
  XFreeModifiermap(mods);
  return ok && !(state.mods & ~(owned_mods | ctx->locked_mods)) &&
         !(state.base_mods & ~owned_mods) && !failed;
}
static KeySym text_symbol(uint32_t c) {
  if (c == '\n' || c == '\r') return XK_Return;
  if (c == '\t') return XK_Tab;
  return xkb_utf32_to_keysym(c);
}
static bool text_key(uint32_t c, const struct text_context *ctx,
                     KeyCode *code, bool *shift) {
  KeySym wanted = text_symbol(c);
  for (int level = 0; level < 2; level++) {
    if (level && !ctx->shift) continue;
    for (int k = keymap->min_key_code; k <= keymap->max_key_code; k++) {
      if (ctx->modifier[k] || (ctx->held[k / 8] & (1u << (k % 8)))) continue;
      unsigned int consumed;
      KeySym sym;
      if (XkbTranslateKeyCode(keymap, (KeyCode)k,
          XkbBuildCoreState(ctx->locked_mods | (level ? ShiftMask : 0), ctx->group),
          &consumed, &sym) &&
          (sym == wanted || (c != '\n' && c != '\r' && c != '\t' &&
                             xkb_keysym_to_utf32(sym) == c))) {
        *code = (KeyCode)k;
        *shift = level != 0;
        return true;
      }
    }
  }
  return false;
}
bool backend_text_available(const char *text) {
  if (!*text) return true;
  if (!backend_dispatch()) return false;
  struct text_context ctx;
  if (!text_context(&ctx)) return false;
  const unsigned char *p = (const unsigned char *)text;
  while (*p) {
    KeyCode code;
    bool shift;
    if (!text_key(codepoint(&p), &ctx, &code, &shift)) return false;
  }
  return true;
}
static bool text_edge(KeyCode code, bool down) {
  if (!XTestFakeKeyEvent(display, code, down, CurrentTime)) return false;
  keys[code] = down;
  return !failed;
}
bool backend_text(const char *text) {
  if (!*text) return true;
  // Repeat full preflight at execution time, before releasing or injecting
  // anything. Unsupported characters therefore cannot partially type a string.
  if (!backend_text_available(text)) return false;
  // Suspend our keys while typing, then restore them so a held Shift continues
  // to apply to subsequent shortcuts. Mouse buttons remain untouched.
  bool suspended[256];
  memcpy(suspended, keys, sizeof(suspended));
  for (int c = 0; c < 256; c++) if (suspended[c]) {
    if (!XTestFakeKeyEvent(display, c, False, CurrentTime)) return false;
    keys[c] = false;
  }
  if (!backend_sync()) return false;
  const unsigned char *p = (const unsigned char *)text;
  while (*p && !stopping) {
    struct text_context ctx;
    KeyCode code;
    bool shift;
    if (!backend_dispatch() || !text_context(&ctx) ||
        !text_key(codepoint(&p), &ctx, &code, &shift)) return false;
    if (shift && !text_edge(ctx.shift, true)) return false;
    if (!text_edge(code, true) || !text_edge(code, false)) return false;
    if (shift && !text_edge(ctx.shift, false)) return false;
    if (!backend_sync()) return false;
  }
  if (failed || stopping) return false;
  for (int c = 0; c < 256; c++) if (suspended[c]) {
    // Do not claim a key another user pressed while text was being injected.
    if (pressed((KeyCode)c)) {
      for (int code = 0; code < 256; code++)
        if (held_keys[code] == c) held_keys[code] = 0;
      continue;
    }
    if (!XTestFakeKeyEvent(display, c, True, CurrentTime)) return false;
    keys[c] = true;
  }
  return backend_sync();
}
void backend_close(void) {
  if (!display) return;
  if (keymap) { XkbFreeKeyboard(keymap, XkbAllComponentsMask, True); keymap = NULL; }
  XCloseDisplay(display);
  display = NULL;
}
