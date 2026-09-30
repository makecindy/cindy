#define _GNU_SOURCE
#include "wlr-data-control-unstable-v1.h"
#include <json-c/json.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wayland-client.h>

/* One portable clipboard offer, supplied through stdin, never argv or a file.
 * No observation of clipboard contents. The compositor requests only offered
 * MIME types; replacement or parent EOF destroys the in-memory offer. */
struct item {
  const char *mime;
  unsigned char *bytes;
  size_t length;
};
static struct item items[4];
static struct wl_seat *seat;
static struct zwlr_data_control_manager_v1 *manager;
static int cancelled;
static void global(void *d, struct wl_registry *r, uint32_t n, const char *i,
                   uint32_t v) {
  (void)d;
  (void)v;
  if (!strcmp(i, wl_seat_interface.name) && !seat)
    seat = wl_registry_bind(r, n, &wl_seat_interface, 1);
  if (!strcmp(i, zwlr_data_control_manager_v1_interface.name))
    manager =
        wl_registry_bind(r, n, &zwlr_data_control_manager_v1_interface, 1);
}
static void removed(void *d, struct wl_registry *r, uint32_t n) {
  (void)d;
  (void)r;
  (void)n;
}
static const struct wl_registry_listener registry_listener = {global, removed};
static void send_data(void *d, struct zwlr_data_control_source_v1 *s,
                      const char *mime, int32_t fd) {
  (void)d;
  (void)s;
  alarm(3);
  for (unsigned i = 0; i < 4; i++)
    if (items[i].mime && !strcmp(mime, items[i].mime)) {
      size_t sent = 0;
      while (sent < items[i].length) {
        ssize_t n = write(fd, items[i].bytes + sent, items[i].length - sent);
        if (n <= 0)
          break;
        sent += (size_t)n;
      }
      break;
    }
  close(fd);
  alarm(0);
}
static void replaced(void *d, struct zwlr_data_control_source_v1 *s) {
  (void)d;
  (void)s;
  cancelled = 1;
}
static const struct zwlr_data_control_source_v1_listener source_listener = {
    send_data, replaced};
static void offered_mime(void *d, struct zwlr_data_control_offer_v1 *o,
                         const char *mime) {
  (void)d;
  (void)o;
  (void)mime;
}
static const struct zwlr_data_control_offer_v1_listener offer_listener = {
    .offer = offered_mime};
static void offer(void *d, struct zwlr_data_control_device_v1 *s,
                  struct zwlr_data_control_offer_v1 *o) {
  (void)d;
  (void)s;
  /* MIME events precede selection; keep the proxy until that event arrives. */
  zwlr_data_control_offer_v1_add_listener(o, &offer_listener, NULL);
}
static void selection(void *d, struct zwlr_data_control_device_v1 *s,
                      struct zwlr_data_control_offer_v1 *o) {
  (void)d;
  (void)s;
  /* This write-only helper never receives selection contents. Both regular
   * and primary selections can be discarded once their announcement ends. */
  if (o)
    zwlr_data_control_offer_v1_destroy(o);
}
static void finished(void *d, struct zwlr_data_control_device_v1 *s) {
  (void)d;
  (void)s;
  cancelled = 1;
}
static const struct zwlr_data_control_device_v1_listener device_listener = {
    .data_offer = offer,
    .selection = selection,
    .finished = finished,
    .primary_selection = selection};
static int decode(const char *text, size_t size, unsigned char **out,
                  size_t *length) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (size % 4 || size > 11184812)
    return -1;
  unsigned char *bytes = malloc(size / 4 * 3 + 1);
  if (!bytes)
    return -1;
  size_t n = 0;
  for (size_t i = 0; i < size; i += 4) {
    uint32_t value = 0;
    unsigned padding = 0;
    for (unsigned j = 0; j < 4; j++) {
      const char *p = strchr(alphabet, text[i + j]);
      if (text[i + j] == '=' && i + 4 == size && j >= 2) {
        padding++;
        value <<= 6;
      } else if (p && text[i + j] && !padding)
        value = (value << 6) | (uint32_t)(p - alphabet);
      else {
        free(bytes);
        return -1;
      }
    }
    bytes[n++] = (unsigned char)(value >> 16);
    if (padding < 2)
      bytes[n++] = (unsigned char)(value >> 8);
    if (!padding)
      bytes[n++] = (unsigned char)value;
  }
  *out = bytes;
  *length = n;
  return n <= 8388608 ? 0 : -1;
}
static int payload(const char *line) {
  struct json_tokener *tok = json_tokener_new_ex(8);
  if (!tok)
    return -1;
  json_object *root = json_tokener_parse_ex(tok, line, (int)strlen(line));
  int valid = json_tokener_get_error(tok) == json_tokener_success && root &&
              json_object_is_type(root, json_type_object);
  json_tokener_free(tok);
  if (!valid) {
    if (root)
      json_object_put(root);
    return -1;
  }
  const char *keys[] = {"text", "html", "rtf", "png"};
  const char *mimes[] = {"text/plain;charset=utf-8", "text/html", "text/rtf",
                         "image/png"};
  unsigned found = 0;
  for (unsigned i = 0; i < 4; i++) {
    json_object *value = NULL;
    if (!json_object_object_get_ex(root, keys[i], &value))
      continue;
    if (!json_object_is_type(value, json_type_string)) {
      valid = 0;
      break;
    }
    size_t length = (size_t)json_object_get_string_len(value);
    const char *bytes = json_object_get_string(value);
    if (i == 3) {
      if (decode(bytes, length, &items[i].bytes, &items[i].length)) {
        valid = 0;
        break;
      }
    } else {
      if (length > 2097152) {
        valid = 0;
        break;
      }
      items[i].bytes = malloc(length + 1);
      if (!items[i].bytes) {
        valid = 0;
        break;
      }
      memcpy(items[i].bytes, bytes, length);
      items[i].length = length;
    }
    items[i].mime = mimes[i];
    found++;
  }
  json_object_put(root);
  return valid && found ? 0 : -1;
}
int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  alarm(5);
  char *line = malloc(16000002);
  if (!line)
    return 1;
  int status = 1;
  struct wl_display *display = NULL;
  struct wl_registry *registry = NULL;
  struct zwlr_data_control_device_v1 *device = NULL;
  struct zwlr_data_control_source_v1 *source = NULL;
  if (!fgets(line, 16000002, stdin) || !strchr(line, '\n') || payload(line))
    goto done;
  if (argc == 2 && !strcmp(argv[1], "--check")) {
    status = 0;
    goto done;
  }
  if (argc != 1)
    goto done;
  display = wl_display_connect(NULL);
  if (!display)
    goto done;
  registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  if (wl_display_roundtrip(display) < 0 || !seat || !manager)
    goto done;
  device = zwlr_data_control_manager_v1_get_data_device(manager, seat);
  zwlr_data_control_device_v1_add_listener(device, &device_listener, NULL);
  source = zwlr_data_control_manager_v1_create_data_source(manager);
  zwlr_data_control_source_v1_add_listener(source, &source_listener, NULL);
  for (unsigned i = 0; i < 4; i++)
    if (items[i].mime)
      zwlr_data_control_source_v1_offer(source, items[i].mime);
  zwlr_data_control_device_v1_set_selection(device, source);
  if (wl_display_roundtrip(display) < 0)
    goto done;
  puts("ready");
  fflush(stdout);
  alarm(0);
  while (!cancelled) {
    while (wl_display_prepare_read(display) != 0)
      if (wl_display_dispatch_pending(display) < 0)
        goto done;
    if (wl_display_flush(display) < 0) {
      wl_display_cancel_read(display);
      goto done;
    }
    struct pollfd fds[] = {{wl_display_get_fd(display), POLLIN, 0},
                           {STDIN_FILENO, POLLIN, 0}};
    int n = poll(fds, 2, -1);
    if (n < 0 || fds[1].revents) {
      wl_display_cancel_read(display);
      break;
    }
    if (fds[0].revents & POLLIN) {
      if (wl_display_read_events(display) < 0)
        goto done;
    } else {
      wl_display_cancel_read(display);
      if (fds[0].revents)
        break;
    }
    if (wl_display_dispatch_pending(display) < 0)
      goto done;
  }
  status = 0;
done:
  if (source)
    zwlr_data_control_source_v1_destroy(source);
  if (device)
    zwlr_data_control_device_v1_destroy(device);
  if (manager)
    zwlr_data_control_manager_v1_destroy(manager);
  if (seat)
    wl_seat_destroy(seat);
  if (registry)
    wl_registry_destroy(registry);
  if (display)
    wl_display_disconnect(display);
  for (unsigned i = 0; i < 4; i++)
    free(items[i].bytes);
  free(line);
  return status;
}
