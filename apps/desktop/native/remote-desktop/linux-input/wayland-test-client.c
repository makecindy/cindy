#define _GNU_SOURCE
#include <assert.h>
#include <sys/socket.h>
#include <wayland-server.h>
#include "wayland.c"

// Explicit integration: exercise production backend_dispatch with a real Wayland
// connection, without a desktop or input injection. Regression: an idle dispatch
// sent a sync request and blocked before every input batch. The parser's
// --validate path never enters this function. The alarm bounds the old failure.
static bool completed;
static void done(void *data, struct wl_callback *callback, uint32_t serial) {
  (void)data;
  (void)serial;
  completed = true;
  wl_callback_destroy(callback);
}
static const struct wl_callback_listener listener = {.done = done};
int main(void) {
  alarm(2);
  int sockets[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  struct wl_display *server = wl_display_create();
  assert(server);
  assert(wl_client_create(server, sockets[0]));
  display = wl_display_connect_to_fd(sockets[1]);
  assert(display);

  // No server loop is running: this must return without requesting a roundtrip.
  assert(backend_dispatch());
  for (int queued = 0; queued < 2; queued++) {
    completed = false;
    struct wl_callback *callback = wl_display_sync(display);
    assert(callback);
    assert(wl_callback_add_listener(callback, &listener, NULL) == 0);
    assert(wl_display_flush(display) >= 0);
    assert(wl_event_loop_dispatch(wl_display_get_event_loop(server), 0) >= 0);
    wl_display_flush_clients(server);
    if (queued) {
      // Move the reply into the client queue, leaving its socket unreadable.
      assert(wl_display_prepare_read(display) == 0);
      assert(wl_display_read_events(display) == 0);
    }
    assert(backend_dispatch());
    assert(completed);
  }
  wl_display_destroy_clients(server);
  assert(!backend_dispatch());
  wl_display_disconnect(display);
  display = NULL;
  wl_display_destroy(server);
  return 0;
}
