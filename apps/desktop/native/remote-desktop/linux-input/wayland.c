#define _GNU_SOURCE
#include "backend.h"
#include "virtual-keyboard-unstable-v1.h"
#include "wlr-virtual-pointer-unstable-v1.h"
#include <errno.h>
#include <json-c/json.h>
#include <linux/input-event-codes.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

// Private stdin/stdout protocol, identical lifecycle to the other input
// helpers. No sockets beyond the user's compositor, root privileges, or input
// logging.
static struct wl_display *display;
static struct wl_seat *seat;
static struct zwp_virtual_keyboard_manager_v1 *keyboard_manager;
static struct zwlr_virtual_pointer_manager_v1 *pointer_manager;
static struct zwp_virtual_keyboard_v1 *keyboard;
static struct zwlr_virtual_pointer_v1 *pointer;
static struct xkb_keymap *keymap;
static struct xkb_state *state;
static bool keys[256], buttons[3];

static const uint32_t button_codes[] = {BTN_LEFT, BTN_MIDDLE, BTN_RIGHT};
static uint32_t now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint32_t)((uint64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000);
}
static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
  (void)data;
  (void)version;
  if (!seat && !strcmp(interface, "wl_seat"))
    seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  if (!strcmp(interface, "zwp_virtual_keyboard_manager_v1"))
    keyboard_manager = wl_registry_bind(
        registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
  if (!strcmp(interface, "zwlr_virtual_pointer_manager_v1"))
    pointer_manager = wl_registry_bind(
        registry, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}
static const struct wl_registry_listener registry_listener = {global, removed};
static bool set_keymap(struct zwp_virtual_keyboard_v1 *target,
                       const char *text) {
  size_t size = strlen(text) + 1;
  int fd = memfd_create("cindy-input-keymap", MFD_CLOEXEC);
  if (fd < 0)
    return false;
  bool ok = ftruncate(fd, (off_t)size) == 0;
  void *memory =
      ok ? mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
         : MAP_FAILED;
  if (memory == MAP_FAILED) {
    close(fd);
    return false;
  }
  memcpy(memory, text, size);
  zwp_virtual_keyboard_v1_keymap(target, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd,
                                 (uint32_t)size);
  munmap(memory, size);
  close(fd);
  return wl_display_roundtrip(display) >= 0;
}
static void modifiers(void) {
  zwp_virtual_keyboard_v1_modifiers(
      keyboard, xkb_state_serialize_mods(state, XKB_STATE_MODS_DEPRESSED),
      xkb_state_serialize_mods(state, XKB_STATE_MODS_LATCHED),
      xkb_state_serialize_mods(state, XKB_STATE_MODS_LOCKED),
      xkb_state_serialize_layout(state, XKB_STATE_LAYOUT_EFFECTIVE));
}
static void key(uint32_t code, bool down) {
  if (keys[code] == down)
    return;
  keys[code] = down;
  zwp_virtual_keyboard_v1_key(keyboard, now(), code, down);
  xkb_state_update_key(state, code + 8, down ? XKB_KEY_DOWN : XKB_KEY_UP);
  modifiers();
}
void backend_release(void) {
  if (keyboard && state)
    for (uint32_t i = 0; i < 256; i++)
      if (keys[i])
        key(i, false);
  if (pointer) {
    for (int i = 0; i < 3; i++)
      if (buttons[i]) {
        zwlr_virtual_pointer_v1_button(pointer, now(), button_codes[i], 0);
        buttons[i] = false;
      }
    zwlr_virtual_pointer_v1_frame(pointer);
  }
}
bool backend_text_available(const char *text) { (void)text; return true; }
bool backend_text(const char *text) {
  if (!*text)
    return true;
  backend_release(); // Text commits are not keyboard shortcuts; never leave
                 // modifiers held.
  uint32_t syms[4096];
  size_t count = 0;
  const unsigned char *p = (const unsigned char *)text;
  while (*p && count < 4096) {
    uint32_t c = codepoint(&p);
    syms[count++] = c == '\n' || c == '\r' ? XKB_KEY_Return
                    : c == '\t'            ? XKB_KEY_Tab
                                           : xkb_utf32_to_keysym(c);
  }
  if (*p)
    return false;
  bool ok = true;
  // A separate keyboard gives each layout a distinct compositor identity.
  // Replacing a keymap on the active physical-key device can leave clients
  // translating subsequent shortcuts with the previous text-only map.
  // Restrict text to ordinary digit/letter scan codes: clients may dispatch
  // multimedia shortcuts by scan code even when the keysym is printable.
  static const uint32_t text_codes[] = {
      2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 16, 17, 18, 19, 20, 21, 22, 23,
      24, 25, 30, 31, 32, 33, 34, 35, 36, 37, 38, 44, 45, 46, 47, 48, 49, 50};
  const size_t capacity = sizeof(text_codes) / sizeof(text_codes[0]);
  for (size_t offset = 0; offset < count && ok && !stopping;
       offset += capacity) {
    size_t chunk = count - offset < capacity ? count - offset : capacity;
    char *map = NULL;
    size_t length = 0;
    FILE *f = open_memstream(&map, &length);
    if (!f)
      return false;
    fprintf(f, "xkb_keymap { xkb_keycodes { minimum=8; maximum=58;");
    for (size_t i = 0; i < chunk; i++)
      fprintf(f, "<T%03zx>=%u;", i, text_codes[i] + 8);
    fprintf(f, "}; xkb_types { type \"ONE_LEVEL\" { modifiers=None; "
               "map[None]=Level1; }; }; xkb_compatibility {}; xkb_symbols {");
    for (size_t i = 0; i < chunk; i++)
      fprintf(f, "key <T%03zx> { type=\"ONE_LEVEL\", [ 0x%x ] };", i,
              syms[offset + i]);
    fprintf(f, "}; };");
    fclose(f);
    struct zwp_virtual_keyboard_v1 *text_keyboard =
        zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(
            keyboard_manager, seat);
    ok = set_keymap(text_keyboard, map);
    free(map);
    if (ok) {
      zwp_virtual_keyboard_v1_modifiers(text_keyboard, 0, 0, 0, 0);
      for (size_t i = 0; i < chunk && !stopping; i++) {
        zwp_virtual_keyboard_v1_key(text_keyboard, now(), text_codes[i], 1);
        if (wl_display_roundtrip(display) < 0) {
          ok = false;
          break;
        }
        // Give the focused client/IME time to consume each edge (as wtype
        // does); flooding key pairs silently loses text in Chromium.
        struct timespec pace = {.tv_nsec = 2000000};
        nanosleep(&pace, NULL);
        zwp_virtual_keyboard_v1_key(text_keyboard, now(), text_codes[i], 0);
        if (wl_display_roundtrip(display) < 0) {
          ok = false;
          break;
        }
        nanosleep(&pace, NULL);
      }
      ok = wl_display_roundtrip(display) >= 0 && ok;
    }
    zwp_virtual_keyboard_v1_destroy(text_keyboard);
    if (wl_display_roundtrip(display) < 0)
      ok = false;
  }
  modifiers();
  return ok;
}

bool backend_open(bool check, const struct geometry *geometry) {
  if (geometry->supplied) return false;
  display = wl_display_connect(NULL);
  if (!display) return false;
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  bool ready = wl_display_roundtrip(display) >= 0 && seat &&
               keyboard_manager && pointer_manager;
  wl_registry_destroy(registry);
  if (!ready) return false;
  if (check) return true;
  struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  if (!ctx) return false;
  struct xkb_rule_names names = {.layout = "us"};
  keymap = xkb_keymap_new_from_names(ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
  xkb_context_unref(ctx);
  if (!keymap) return false;
  state = xkb_state_new(keymap);
  if (!state) return false;
  keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(keyboard_manager, seat);
  pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointer_manager, NULL);
  char *map = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
  bool ok = map && set_keymap(keyboard, map);
  free(map);
  if (!ok) return false;
  modifiers();
  return backend_sync();
}
int backend_fd(void) { return wl_display_get_fd(display); }
bool backend_dispatch(void) {
  // This helper is the only reader. Drain queued events, then read only if the
  // socket is ready; an unconditional roundtrip adds a wait before every batch.
  if (wl_display_dispatch_pending(display) < 0) return false;
  struct pollfd fd = {wl_display_get_fd(display), POLLIN, 0};
  int ready = poll(&fd, 1, 0);
  if (ready < 0) return errno == EINTR;
  if (fd.revents & (POLLERR | POLLHUP | POLLNVAL)) return false;
  return !(fd.revents & POLLIN) || wl_display_dispatch(display) >= 0;
}
bool backend_sync(void) { return wl_display_roundtrip(display) >= 0; }
bool backend_key_available(uint32_t code) { return code < 256; }
bool backend_key(uint32_t code, bool down) { key(code, down); return true; }
bool backend_pointer(double x, double y, int button, bool down) {
  zwlr_virtual_pointer_v1_motion_absolute(
      pointer, now(), (uint32_t)llround(x * 1000000),
      (uint32_t)llround(y * 1000000), 1000000, 1000000);
  if (button >= 0) {
    zwlr_virtual_pointer_v1_frame(pointer);
    if (!backend_sync()) return false;
    if (buttons[button] != down) {
      buttons[button] = down;
      zwlr_virtual_pointer_v1_button(pointer, now(), button_codes[button], down);
    }
  }
  zwlr_virtual_pointer_v1_frame(pointer);
  return true;
}
bool backend_scroll(double x, double y) {
  zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_CONTINUOUS);
  if (x) zwlr_virtual_pointer_v1_axis(pointer, now(),
      WL_POINTER_AXIS_HORIZONTAL_SCROLL, wl_fixed_from_double(x));
  if (y) zwlr_virtual_pointer_v1_axis(pointer, now(),
      WL_POINTER_AXIS_VERTICAL_SCROLL, wl_fixed_from_double(y));
  zwlr_virtual_pointer_v1_frame(pointer);
  return true;
}
void backend_close(void) {
  if (!display) return;
  if (keyboard) zwp_virtual_keyboard_v1_destroy(keyboard);
  if (pointer) zwlr_virtual_pointer_v1_destroy(pointer);
  wl_display_flush(display);
  wl_display_disconnect(display);
  if (state) xkb_state_unref(state);
  if (keymap) xkb_keymap_unref(keymap);
}
