#define _GNU_SOURCE
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
static volatile sig_atomic_t stopping;
static const uint32_t button_codes[] = {BTN_LEFT, BTN_MIDDLE, BTN_RIGHT};
static uint32_t now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint32_t)((uint64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000);
}
static void interrupted(int sig) {
  stopping = 1;
  if (sig == SIGALRM) {
    signal(SIGALRM, SIG_DFL);
    alarm(
        1); // Bound shutdown if the compositor itself has stopped servicing us.
  }
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
static void release_all(void) {
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
static int key_code(const char *name) {
  if (strlen(name) == 4 && !strncmp(name, "Key", 3) && name[3] >= 'A' &&
      name[3] <= 'Z') {
    static const int codes[] = {30, 48, 46, 32, 18, 33, 34, 35, 23,
                                36, 37, 38, 50, 49, 24, 25, 16, 19,
                                31, 20, 22, 47, 17, 45, 21, 44};
    return codes[name[3] - 'A'];
  }
  if (strlen(name) == 6 && !strncmp(name, "Digit", 5) && name[5] >= '0' &&
      name[5] <= '9')
    return name[5] == '0' ? KEY_0 : KEY_1 + name[5] - '1';
  const struct {
    const char *name;
    int code;
  } map[] = {
      {"F1", KEY_F1},
      {"F2", KEY_F2},
      {"F3", KEY_F3},
      {"F4", KEY_F4},
      {"F5", KEY_F5},
      {"F6", KEY_F6},
      {"F7", KEY_F7},
      {"F8", KEY_F8},
      {"F9", KEY_F9},
      {"F10", KEY_F10},
      {"F11", KEY_F11},
      {"F12", KEY_F12},
      {"Enter", KEY_ENTER},
      {"Escape", KEY_ESC},
      {"Tab", KEY_TAB},
      {"Space", KEY_SPACE},
      {"Backspace", KEY_BACKSPACE},
      {"Delete", KEY_DELETE},
      {"Insert", KEY_INSERT},
      {"Home", KEY_HOME},
      {"End", KEY_END},
      {"PageUp", KEY_PAGEUP},
      {"PageDown", KEY_PAGEDOWN},
      {"ArrowUp", KEY_UP},
      {"ArrowDown", KEY_DOWN},
      {"ArrowLeft", KEY_LEFT},
      {"ArrowRight", KEY_RIGHT},
      {"ShiftLeft", KEY_LEFTSHIFT},
      {"ControlLeft", KEY_LEFTCTRL},
      {"AltLeft", KEY_LEFTALT},
      {"MetaLeft", KEY_LEFTMETA},
      {"Minus", KEY_MINUS},
      {"Equal", KEY_EQUAL},
      {"BracketLeft", KEY_LEFTBRACE},
      {"BracketRight", KEY_RIGHTBRACE},
      {"Backslash", KEY_BACKSLASH},
      {"Semicolon", KEY_SEMICOLON},
      {"Quote", KEY_APOSTROPHE},
      {"Backquote", KEY_GRAVE},
      {"Comma", KEY_COMMA},
      {"Period", KEY_DOT},
      {"Slash", KEY_SLASH},
  };
  for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); i++)
    if (!strcmp(name, map[i].name))
      return map[i].code;
  return -1;
}
static const char *string(json_object *object, const char *name) {
  json_object *value;
  if (!json_object_object_get_ex(object, name, &value) ||
      !json_object_is_type(value, json_type_string))
    return NULL;
  const char *text = json_object_get_string(value);
  return strlen(text) == (size_t)json_object_get_string_len(value) ? text
                                                                   : NULL;
}
static bool number(json_object *object, const char *name, double min,
                   double max, double *out) {
  json_object *value;
  if (!json_object_object_get_ex(object, name, &value) ||
      (!json_object_is_type(value, json_type_int) &&
       !json_object_is_type(value, json_type_double)))
    return false;
  *out = json_object_get_double(value);
  return isfinite(*out) && *out >= min && *out <= max;
}
static bool boolean(json_object *object, const char *name, bool *out) {
  json_object *value;
  if (!json_object_object_get_ex(object, name, &value) ||
      !json_object_is_type(value, json_type_boolean))
    return false;
  *out = json_object_get_boolean(value);
  return true;
}
// JSON parser validates UTF-8 before this decoder is used.
static uint32_t codepoint(const unsigned char **cursor) {
  const unsigned char *p = *cursor;
  uint32_t c = *p++;
  int rest = c < 0x80 ? 0 : c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
  if (rest)
    c &= (1u << (6 - rest)) - 1;
  while (rest--)
    c = (c << 6) | (*p++ & 63);
  *cursor = p;
  return c;
}
static bool text_input(const char *text) {
  if (!*text)
    return true;
  release_all(); // Text commits are not keyboard shortcuts; never leave
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

static bool event(json_object *object, bool apply) {
  if (!json_object_is_type(object, json_type_object))
    return false;
  const char *kind = string(object, "kind");
  if (!kind)
    return false;
  double x = 0, y = 0, button = 0;
  bool down = false;
  if (!strcmp(kind, "release")) {
    if (apply)
      release_all();
    return true;
  }
  if (!strcmp(kind, "move") || !strcmp(kind, "button")) {
    if (!number(object, "x", 0, 1, &x) || !number(object, "y", 0, 1, &y))
      return false;
    bool click = !strcmp(kind, "button");
    if (click && (!number(object, "button", 0, 2, &button) ||
                  button != floor(button) || !boolean(object, "down", &down)))
      return false;
    if (apply) {
      zwlr_virtual_pointer_v1_motion_absolute(
          pointer, now(), (uint32_t)llround(x * 1000000),
          (uint32_t)llround(y * 1000000), 1000000, 1000000);
      if (click) {
        // Deliver absolute motion before the button, so a first tap targets
        // its requested surface instead of the previously focused surface.
        zwlr_virtual_pointer_v1_frame(pointer);
        if (wl_display_roundtrip(display) < 0)
          return false;
        buttons[(int)button] = down;
        zwlr_virtual_pointer_v1_button(pointer, now(),
                                       button_codes[(int)button], down);
      }
      zwlr_virtual_pointer_v1_frame(pointer);
    }
    return true;
  }
  if (!strcmp(kind, "scroll")) {
    if (!number(object, "dx", -2000, 2000, &x) ||
        !number(object, "dy", -2000, 2000, &y))
      return false;
    if (apply) {
      zwlr_virtual_pointer_v1_axis_source(pointer,
                                          WL_POINTER_AXIS_SOURCE_CONTINUOUS);
      if (x)
        zwlr_virtual_pointer_v1_axis(pointer, now(),
                                     WL_POINTER_AXIS_HORIZONTAL_SCROLL,
                                     wl_fixed_from_double(x));
      if (y)
        zwlr_virtual_pointer_v1_axis(pointer, now(),
                                     WL_POINTER_AXIS_VERTICAL_SCROLL,
                                     wl_fixed_from_double(y));
      zwlr_virtual_pointer_v1_frame(pointer);
    }
    return true;
  }
  if (!strcmp(kind, "key")) {
    const char *code = string(object, "code");
    int mapped = code ? key_code(code) : -1;
    if (mapped < 0 || !boolean(object, "down", &down))
      return false;
    if (apply)
      key((uint32_t)mapped, down);
    return true;
  }
  if (!strcmp(kind, "text")) {
    const char *text = string(object, "text");
    if (!text || strlen(text) > 16384)
      return false;
    const unsigned char *p = (const unsigned char *)text;
    size_t count = 0;
    while (*p) {
      codepoint(&p);
      if (++count > 4096)
        return false;
    }
    return !apply || text_input(text);
  }
  return false;
}
static bool batch(const char *line, size_t size, bool apply) {
  struct json_tokener *tok = json_tokener_new();
  if (!tok)
    return false;
  json_tokener_set_flags(tok, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
  json_object *array = json_tokener_parse_ex(tok, line, (int)size);
  bool ok = json_tokener_get_error(tok) == json_tokener_success &&
            json_tokener_get_parse_end(tok) == size && array &&
            json_object_is_type(array, json_type_array) &&
            json_object_array_length(array) <= 256;
  json_tokener_free(tok);
  if (ok)
    for (size_t i = 0; i < json_object_array_length(array); i++)
      if (!event(json_object_array_get_idx(array, i), false)) {
        ok = false;
        break;
      }
  if (ok && apply)
    for (size_t i = 0; i < json_object_array_length(array) && !stopping; i++)
      if (!event(json_object_array_get_idx(array, i), true)) {
        ok = false;
        break;
      }
  if (array)
    json_object_put(array);
  return ok;
}
int main(int argc, char **argv) {
  bool check = argc == 2 && !strcmp(argv[1], "--check");
  bool validate = argc == 2 && !strcmp(argv[1], "--validate");
  if (argc > 1 && !check && !validate)
    return 2;
  signal(SIGTERM, interrupted);
  signal(SIGINT, interrupted);
  signal(SIGPIPE, SIG_IGN);
  // Also bound Wayland roundtrips if the compositor or parent stalls.
  signal(SIGALRM, interrupted);
  alarm(6);
  if (!validate) {
    display = wl_display_connect(NULL);
    if (!display)
      return 2;
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !seat || !keyboard_manager ||
        !pointer_manager)
      return 2;
    if (check) {
      puts("ready");
      wl_display_disconnect(display);
      return 0;
    }
    struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    struct xkb_rule_names names = {.layout = "us"};
    keymap =
        xkb_keymap_new_from_names(ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    xkb_context_unref(ctx);
    if (!keymap)
      return 2;
    state = xkb_state_new(keymap);
    if (!state)
      return 2;
    keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(
        keyboard_manager, seat);
    pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(
        pointer_manager, NULL);
    char *map = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    if (!map || !set_keymap(keyboard, map))
      return 2;
    free(map);
    modifiers();
    if (wl_display_roundtrip(display) < 0)
      return 2;
  }
  puts("ready");
  fflush(stdout);
  char buffer[32769];
  size_t used = 0;
  bool ok = true;
  while (!stopping) {
    struct pollfd fds[2] = {
        {STDIN_FILENO, POLLIN, 0},
        {validate ? -1 : wl_display_get_fd(display), POLLIN, 0}};
    int polled = poll(fds, 2, 6000);
    if (polled <= 0)
      break;
    if (fds[1].revents && wl_display_dispatch(display) < 0)
      break;
    if (!(fds[0].revents & (POLLIN | POLLHUP)))
      continue;
    ssize_t n = read(STDIN_FILENO, buffer + used, 32768 - used);
    if (n <= 0)
      break;
    used += (size_t)n;
    buffer[used] = 0;
    char *newline;
    while ((newline = memchr(buffer, '\n', used))) {
      size_t length = (size_t)(newline - buffer);
      if (!batch(buffer, length, !validate)) {
        ok = false;
        stopping = 1;
        break;
      }
      if (!validate && wl_display_roundtrip(display) < 0) {
        ok = false;
        stopping = 1;
        break;
      }
      puts("ok");
      fflush(stdout);
      alarm(6);
      size_t remaining = used - length - 1;
      memmove(buffer, newline + 1, remaining);
      used = remaining;
    }
    if (used == 32768) {
      ok = false;
      break;
    }
  }
  if (!validate) {
    release_all();
    // Wait for releases to be processed before removing virtual devices.
    wl_display_roundtrip(display);
    zwp_virtual_keyboard_v1_destroy(keyboard);
    zwlr_virtual_pointer_v1_destroy(pointer);
    wl_display_flush(display);
    wl_display_disconnect(display);
    xkb_state_unref(state);
    xkb_keymap_unref(keymap);
  }
  return ok ? 0 : 2;
}
