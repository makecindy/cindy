#define _GNU_SOURCE
#include "backend.h"
#include <errno.h>
#include <json-c/json.h>
#include <linux/input-event-codes.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Private bounded NDJSON protocol; neither backend sees unvalidated batches.
volatile sig_atomic_t stopping;
static bool validating;
static void interrupted(int sig) {
  if (stopping) return;
  stopping = 1;
  (void)sig;
  // SIGTERM also has a hard cleanup bound, not the remaining idle deadline.
  signal(SIGALRM, SIG_DFL);
  alarm(1);
}
// Never replace a pending shutdown's one-second hard bound with an idle timer.
static void watchdog(void) {
  sigset_t signals, previous;
  sigemptyset(&signals);
  sigaddset(&signals, SIGTERM);
  sigaddset(&signals, SIGINT);
  sigaddset(&signals, SIGALRM);
  sigprocmask(SIG_BLOCK, &signals, &previous);
  if (!stopping) alarm(6);
  sigprocmask(SIG_SETMASK, &previous, NULL);
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
// Raw UTF-8 is validated before parsing; json-c decodes JSON Unicode escapes.
uint32_t codepoint(const unsigned char **cursor) {
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
      backend_release();
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
      return backend_pointer(x, y, click ? (int)button : -1, down);
    }
    return true;
  }
  if (!strcmp(kind, "scroll")) {
    if (!number(object, "dx", -2000, 2000, &x) ||
        !number(object, "dy", -2000, 2000, &y))
      return false;
    if (apply) {
      return backend_scroll(x, y);
    }
    return true;
  }
  if (!strcmp(kind, "key")) {
    const char *code = string(object, "code");
    int mapped = code ? key_code(code) : -1;
    if (mapped < 0 || (!validating && !backend_key_available((uint32_t)mapped)) ||
        !boolean(object, "down", &down))
      return false;
    if (apply)
      return backend_key((uint32_t)mapped, down);
    return true;
  }
  if (!strcmp(kind, "text") || !strcmp(kind, "text-check")) {
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
    if (!validating && !backend_text_available(text)) return false;
    // Private side-effect-free preflight for a complete paste before chunking.
    return !apply || !strcmp(kind, "text-check") || backend_text(text);
  }
  return false;
}
// json-c 0.18's strict parser treats signed high bytes as control characters.
// Validate shortest-form Unicode first, then normalize raw code points to JSON
// escapes. This retains strict JSON/UTF-8 admission on affected builds too.
static bool valid_utf8(const char *line, size_t size) {
  const unsigned char *bytes = (const unsigned char *)line;
  for (size_t i = 0; i < size;) {
    uint32_t c = bytes[i++], minimum;
    size_t rest;
    if (c < 0x80) continue;
    if (c >= 0xc2 && c <= 0xdf) { rest = 1; minimum = 0x80; c &= 0x1f; }
    else if (c >= 0xe0 && c <= 0xef) { rest = 2; minimum = 0x800; c &= 0x0f; }
    else if (c >= 0xf0 && c <= 0xf4) { rest = 3; minimum = 0x10000; c &= 0x07; }
    else return false;
    if (rest > size - i) return false;
    while (rest--) {
      unsigned char next = bytes[i++];
      if ((next & 0xc0) != 0x80) return false;
      c = (c << 6) | (next & 0x3f);
    }
    if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return false;
  }
  return true;
}
static char *ascii_json(const char *line, size_t size, size_t *length) {
  if (!valid_utf8(line, size)) return NULL;
  char *escaped = malloc(size * 3 + 1);
  if (!escaped) return NULL;
  size_t used = 0;
  bool slash = false;
  const unsigned char *cursor = (const unsigned char *)line;
  const unsigned char *end = cursor + size;
  while (cursor < end) {
    if (*cursor < 0x80) {
      unsigned char c = *cursor++;
      escaped[used++] = (char)c;
      slash = c == '\\' ? !slash : false;
      continue;
    }
    // A raw non-ASCII byte cannot be the target of a JSON backslash escape.
    // Converting it would otherwise repair invalid input into valid JSON.
    if (slash) { free(escaped); return NULL; }
    uint32_t c = codepoint(&cursor);
    if (c <= 0xffff)
      used += (size_t)snprintf(escaped + used, 7, "\\u%04x", c);
    else {
      c -= 0x10000;
      used += (size_t)snprintf(escaped + used, 13, "\\u%04x\\u%04x",
                              0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  escaped[used] = 0;
  *length = used;
  return escaped;
}
static bool batch(const char *line, size_t size, bool apply) {
  size_t length;
  char *normalized = ascii_json(line, size, &length);
  if (!normalized) return false;
  struct json_tokener *tok = json_tokener_new();
  if (!tok) { free(normalized); return false; }
  json_tokener_set_flags(tok, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
  json_object *array = json_tokener_parse_ex(tok, normalized, (int)length);
  free(normalized);
  bool ok = json_tokener_get_error(tok) == json_tokener_success &&
            json_tokener_get_parse_end(tok) == length && array &&
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
// X11 accepts --geometry x y width height (integer root pixels). Omission
// selects the entire default X screen. Wayland intentionally rejects geometry.
static bool arguments(int argc, char **argv, bool *check, bool *validate,
                      struct geometry *geometry) {
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--check") && !*check && !*validate) *check = true;
    else if (!strcmp(argv[i], "--validate") && !*validate && !*check) *validate = true;
    else if (!strcmp(argv[i], "--geometry") && !geometry->supplied && i + 4 < argc) {
      int *fields[] = {&geometry->x, &geometry->y, &geometry->width, &geometry->height};
      for (int j = 0; j < 4; j++) {
        const char *arg = argv[++i];
        if (!*arg) return false;
        for (const char *p = arg; *p; p++) if (*p < '0' || *p > '9') return false;
        errno = 0;
        char *end;
        long value = strtol(arg, &end, 10);
        if (errno || *end || value > 32767 || (j >= 2 && value == 0)) return false;
        *fields[j] = (int)value;
      }
      geometry->supplied = true;
    } else return false;
  }
  return true;
}
int main(int argc, char **argv) {
  bool check = false, validate = false;
  struct geometry geometry = {0};
  if (!arguments(argc, argv, &check, &validate, &geometry)) return 2;
  validating = validate;
  struct sigaction action = {.sa_handler = interrupted};
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGALRM, &action, NULL);
  signal(SIGPIPE, SIG_IGN);
  watchdog();
  if (!validate && !backend_open(check, &geometry)) {
    backend_close();
    return 2;
  }
  if (check) {
    puts("ready");
    backend_close();
    return 0;
  }
  puts("ready");
  fflush(stdout);
  char buffer[32769];
  size_t used = 0;
  bool ok = true;
  while (!stopping) {
    struct pollfd fds[2] = {
        {STDIN_FILENO, POLLIN, 0},
        {validate ? -1 : backend_fd(), POLLIN, 0}};
    int polled = poll(fds, 2, 6000);
    if (polled <= 0) break;
    if (fds[1].revents && !backend_dispatch()) { ok = false; break; }
    if (!(fds[0].revents & (POLLIN | POLLHUP))) continue;
    ssize_t n = read(STDIN_FILENO, buffer + used, 32768 - used);
    if (n <= 0) { if (used) ok = false; break; }
    used += (size_t)n;
    buffer[used] = 0;
    char *newline;
    while ((newline = memchr(buffer, '\n', used))) {
      size_t length = (size_t)(newline - buffer);
      if ((!validate && !backend_dispatch()) || stopping ||
          !batch(buffer, length, !validate) || stopping ||
          (!validate && !backend_sync()) || stopping) {
        ok = false;
        stopping = 1;
        break;
      }
      puts("ok");
      fflush(stdout);
      watchdog();
      size_t remaining = used - length - 1;
      memmove(buffer, newline + 1, remaining);
      used = remaining;
    }
    if (used == 32768) { ok = false; break; }
  }
  // All exit paths bound release/sync/close, including plain EOF.
  signal(SIGALRM, SIG_DFL);
  alarm(1);
  if (!validate) {
    backend_release();
    if (!backend_sync()) ok = false;
    backend_close();
  }
  return ok ? 0 : 2;
}
