#define _POSIX_C_SOURCE 200809L
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>
#include <assert.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

// Explicit Xvfb integration receiver, not part of the production build.
// Observe real XTEST events, including text consumed only after the helper ACK.
// Inspecting protocol stdout alone would not prove that XTEST worked.
static Display *display;
static int input, output;
static pid_t helper;
static int presses, releases, clicks, wheels;
static KeySym typed[32];
static int typed_count;
static bool defer_events;
static void receive(void) {
  while (XPending(display)) {
    XEvent e;
    XNextEvent(display, &e);
    if (e.type == MappingNotify) XRefreshKeyboardMapping(&e.xmapping);
    if (e.type == KeyPress) {
      presses++;
      KeySym sym = NoSymbol;
      char buffer[32];
      XLookupString(&e.xkey, buffer, sizeof(buffer), &sym, NULL);
      if (sym != XK_Shift_L && sym != XK_Shift_R && typed_count < 32)
        typed[typed_count++] = sym;
    }
    if (e.type == KeyRelease) releases++;
    if (e.type == ButtonPress) {
      clicks++;
      if (e.xbutton.button >= 4) wheels++;
    }
  }
}
static bool line(const char *expected) {
  char buffer[64]; size_t used = 0;
  struct timespec began, now;
  clock_gettime(CLOCK_MONOTONIC, &began);
  for (;;) {
    if (!defer_events) receive();
    struct pollfd fds[] = {{output, POLLIN, 0},
                          {defer_events ? -1 : ConnectionNumber(display), POLLIN, 0}};
    assert(poll(fds, 2, 1000) >= 0);
    clock_gettime(CLOCK_MONOTONIC, &now);
    assert(now.tv_sec - began.tv_sec < 8);
    if (fds[0].revents & (POLLIN | POLLHUP)) {
      char c;
      if (read(output, &c, 1) != 1) return false;
      assert(used < sizeof(buffer) - 1);
      buffer[used++] = c;
      if (c == '\n') {
        buffer[used] = 0;
        assert(!strcmp(buffer, expected));
        XSync(display, False);
        if (!defer_events) receive();
        return true;
      }
    }
  }
}
static void start(const char *binary, bool check) {
  int in[2], out[2];
  assert(pipe(in) == 0 && pipe(out) == 0);
  helper = fork();
  assert(helper >= 0);
  if (!helper) {
    assert(dup2(in[0], STDIN_FILENO) >= 0);
    assert(dup2(out[1], STDOUT_FILENO) >= 0);
    close(in[0]); close(in[1]); close(out[0]); close(out[1]);
    close(ConnectionNumber(display));
    if (check) execl(binary, binary, "--check", (char *)NULL);
    else execl(binary, binary, "--geometry", "200", "100", "400", "300", (char *)NULL);
    _exit(127);
  }
  close(in[0]); close(out[1]);
  input = in[1]; output = out[0];
  assert(line("ready\n"));
}
static void send_batch(const char *events) {
  size_t size = strlen(events);
  assert(write(input, events, size) == (ssize_t)size);
  assert(line("ok\n"));
}
static void finish(int expected) {
  close(input);
  assert(!line("unexpected\n"));
  int status;
  assert(waitpid(helper, &status, 0) == helper);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == expected);
  close(output);
  XSync(display, False); receive();
}
static bool held(KeyCode code) {
  char bits[32];
  XQueryKeymap(display, bits);
  return (bits[code / 8] & (1u << (code % 8))) != 0;
}
static void pointer(int x, int y, unsigned int buttons) {
  Window root, child; int rx, ry, wx, wy; unsigned int mask;
  assert(XQueryPointer(display, DefaultRootWindow(display), &root, &child,
                       &rx, &ry, &wx, &wy, &mask));
  assert(rx == x && ry == y);
  assert((mask & (Button1Mask | Button2Mask | Button3Mask)) == buttons);
}
int main(int argc, char **argv) {
  assert(argc == 2);
  alarm(25);
  display = XOpenDisplay(NULL);
  assert(display);
  Window window = XCreateSimpleWindow(display, DefaultRootWindow(display),
                                      0, 0, 1024, 768, 0, 0, 0);
  XSelectInput(display, window, KeyPressMask | KeyReleaseMask | ButtonPressMask |
                               ButtonReleaseMask | PointerMotionMask);
  XMapWindow(display, window);
  XSetInputFocus(display, window, RevertToParent, CurrentTime);
  XSync(display, False); receive();
  int min, max, width;
  XDisplayKeycodes(display, &min, &max);
  KeySym *before = XGetKeyboardMapping(display, (KeyCode)min, max - min + 1, &width);
  assert(before);
  start(argv[1], true);
  finish(0);
  assert(presses == 0 && clicks == 0); // Probe must not inject.

  start(argv[1], false);
  // Change names AFTER helper startup to catch missing runtime refresh, while
  // preserving symbols. KeyA must now follow AC01 to the key producing 'b'.
  XkbDescPtr names = XkbGetKeyboard(display, XkbAllComponentsMask, XkbUseCoreKbd);
  assert(names && names->names && names->names->keys);
  KeyCode a = XKeysymToKeycode(display, XK_a), b = XKeysymToKeycode(display, XK_b);
  XkbKeyNameRec original_a = names->names->keys[a];
  names->names->keys[a] = names->names->keys[b];
  names->names->keys[b] = original_a;
  assert(XkbSetNames(display, XkbKeyNamesMask, 0, 0, names));
  XSync(display, False);
  send_batch("[{\"kind\":\"move\",\"x\":1,\"y\":1}]\n");
  pointer(599, 399, 0); // Selected rectangle, not full-root normalization.
  send_batch("[{\"kind\":\"button\",\"button\":0,\"down\":true,\"x\":0,\"y\":0},"
             "{\"kind\":\"button\",\"button\":0,\"down\":false,\"x\":0,\"y\":0},"
             "{\"kind\":\"scroll\",\"dx\":120,\"dy\":-120},"
             "{\"kind\":\"key\",\"code\":\"KeyA\",\"down\":true},"
             "{\"kind\":\"key\",\"code\":\"KeyA\",\"down\":false}]\n");
  pointer(200, 100, 0);
  assert(clicks == 3 && wheels == 2 && presses == 1 && releases == 1);
  assert(typed[0] == XK_b); // Fails for a blind evdev+8 implementation.
  // A keyup must release the KeyCode claimed by keydown, even if its physical
  // name moves in between. The earlier runtime refresh case only remaps idle keys.
  send_batch("[{\"kind\":\"key\",\"code\":\"KeyA\",\"down\":true}]\n");
  assert(held(a) || held(b));
  XkbDescPtr held_names = XkbGetKeyboard(display, XkbAllComponentsMask, XkbUseCoreKbd);
  assert(held_names && held_names->names && held_names->names->keys);
  XkbKeyNameRec held_original_a = held_names->names->keys[a];
  held_names->names->keys[a] = held_names->names->keys[b];
  held_names->names->keys[b] = held_original_a;
  assert(XkbSetNames(display, XkbKeyNamesMask, 0, 0, held_names));
  XSync(display, False);
  send_batch("[{\"kind\":\"key\",\"code\":\"KeyA\",\"down\":false}]\n");
  assert(!held(b) && !held(a));
  held_names->names->keys[b] = held_names->names->keys[a];
  held_names->names->keys[a] = held_original_a;
  assert(XkbSetNames(display, XkbKeyNamesMask, 0, 0, held_names));
  XkbFreeKeyboard(held_names, XkbAllComponentsMask, True);
  typed_count = 0;
  // Deliberately defer all event consumption until after ACK. Stable mappings
  // must still decode exact case, punctuation, whitespace, Return and Tab.
  defer_events = true;
  send_batch("[{\"kind\":\"text\",\"text\":\"aAzZ09!? \\t\\n\"}]\n");
  defer_events = false;
  receive();
  static const KeySym expected[] = {
    XK_a, XK_A, XK_z, XK_Z, XK_0, XK_9, XK_exclam, XK_question,
    XK_space, XK_Tab, XK_Return
  };
  assert(typed_count == (int)(sizeof(expected) / sizeof(expected[0])));
  assert(!memcmp(typed, expected, sizeof(expected)));

  // A remote Shift must survive separate text batches and later key chords.
  // Previously text preflight treated our own Shift as a local modifier.
  KeyCode remote_shift = XKeysymToKeycode(display, XK_Shift_L);
  assert(remote_shift);
  typed_count = 0;
  send_batch("[{\"kind\":\"key\",\"code\":\"ShiftLeft\",\"down\":true}]\n");
  assert(held(remote_shift));
  // Whole-paste preflight must not type or release our held modifiers.
  char prefix[257], preflight[1024];
  memset(prefix, 'a', 256); prefix[256] = 0;
  snprintf(preflight, sizeof(preflight),
           "[{\"kind\":\"text-check\",\"text\":\"%sA\"}]\n", prefix);
  int check_presses = presses, check_releases = releases;
  send_batch(preflight);
  assert(presses == check_presses && releases == check_releases && held(remote_shift));
  send_batch("[{\"kind\":\"text\",\"text\":\"A\"}]\n");
  assert(held(remote_shift));
  send_batch("[{\"kind\":\"text\",\"text\":\"B\"}]\n");
  assert(held(remote_shift));
  send_batch("[{\"kind\":\"key\",\"code\":\"KeyA\",\"down\":true},"
             "{\"kind\":\"key\",\"code\":\"KeyA\",\"down\":false},"
             "{\"kind\":\"key\",\"code\":\"ShiftLeft\",\"down\":false}]\n");
  assert(!held(remote_shift));
  assert(typed_count == 3 && typed[0] == XK_A && typed[1] == XK_B && typed[2] == XK_A);

  // Locked Num/Caps are common local settings. Text must respect them without
  // toggling them, including while the remote user holds Shift.
  unsigned int caps_mask = XkbKeysymToModifiers(display, XK_Caps_Lock);
  unsigned int num_mask = XkbKeysymToModifiers(display, XK_Num_Lock);
  assert(caps_mask && num_mask && !(caps_mask & num_mask));
  for (int mode = 1; mode <= 3; mode++) {
    unsigned int locks = (mode & 1 ? caps_mask : 0) | (mode & 2 ? num_mask : 0);
    assert(XkbLockModifiers(display, XkbUseCoreKbd, caps_mask | num_mask, locks));
    XSync(display, False); receive();
    typed_count = 0;
    send_batch("[{\"kind\":\"key\",\"code\":\"ShiftLeft\",\"down\":true}]\n");
    send_batch("[{\"kind\":\"text\",\"text\":\"aA1!\"}]\n");
    send_batch("[{\"kind\":\"key\",\"code\":\"ShiftLeft\",\"down\":false}]\n");
    static const KeySym locked_expected[] = {XK_a, XK_A, XK_1, XK_exclam};
    assert(typed_count == 4 && !memcmp(typed, locked_expected, sizeof(locked_expected)));
    XkbStateRec state;
    assert(XkbGetState(display, XkbUseCoreKbd, &state) == Success);
    assert((state.locked_mods & (caps_mask | num_mask)) == locks);
  }
  assert(XkbLockModifiers(display, XkbUseCoreKbd, caps_mask | num_mask, 0));
  XSync(display, False); receive();
  int after_width;
  KeySym *after = XGetKeyboardMapping(display, (KeyCode)min, max - min + 1, &after_width);
  assert(after && width == after_width &&
         !memcmp(before, after, (size_t)(max - min + 1) * width * sizeof(KeySym)));
  XFree(after);
  finish(0);

  // Chinese is absent from this default Xvfb map. A valid earlier motion must
  // not execute when text preflight rejects the batch; no keymap is changed.
  start(argv[1], false);
  int previous_presses = presses, previous_clicks = clicks;
  const char *unsupported = "[{\"kind\":\"move\",\"x\":1,\"y\":1},{\"kind\":\"text\",\"text\":\"中文\"}]\n";
  assert(write(input, unsupported, strlen(unsupported)) == (ssize_t)strlen(unsupported));
  finish(2);
  pointer(200, 100, 0);
  assert(presses == previous_presses && clicks == previous_clicks);
  after = XGetKeyboardMapping(display, (KeyCode)min, max - min + 1, &after_width);
  assert(after && width == after_width &&
         !memcmp(before, after, (size_t)(max - min + 1) * width * sizeof(KeySym)));
  XFree(after);

  // PR #6775 discussion_r4398875925: an unsupported suffix must fail the
  // whole-paste check before even an already-queued valid first chunk can type.
  start(argv[1], false);
  snprintf(preflight, sizeof(preflight),
           "[{\"kind\":\"text-check\",\"text\":\"%s中\"}]\n"
           "[{\"kind\":\"text\",\"text\":\"%s\"}]\n", prefix, prefix);
  assert(write(input, preflight, strlen(preflight)) == (ssize_t)strlen(preflight));
  finish(2);
  assert(presses == previous_presses && clicks == previous_clicks);

  // Invalid second event must prevent the first valid motion from executing.
  start(argv[1], false);
  const char *invalid = "[{\"kind\":\"move\",\"x\":1,\"y\":1},{\"kind\":\"key\",\"code\":\"Unknown\",\"down\":true}]\n";
  assert(write(input, invalid, strlen(invalid)) == (ssize_t)strlen(invalid));
  finish(2);
  pointer(200, 100, 0);

  // EOF and SIGTERM release our keys/buttons, but not an already-held user key.
  KeyCode shift = XKeysymToKeycode(display, XK_Shift_L);
  KeyCode ctrl = XKeysymToKeycode(display, XK_Control_L);
  assert(shift && ctrl);
  for (int terminate = 0; terminate < 2; terminate++) {
    assert(XTestFakeKeyEvent(display, shift, True, CurrentTime));
    XSync(display, False); receive();
    start(argv[1], false);
    send_batch("[{\"kind\":\"key\",\"code\":\"ShiftLeft\",\"down\":true},"
               "{\"kind\":\"key\",\"code\":\"ControlLeft\",\"down\":true},"
               "{\"kind\":\"button\",\"button\":0,\"down\":true,\"x\":0,\"y\":0}]\n");
    assert(held(ctrl));
    if (terminate) assert(kill(helper, SIGTERM) == 0);
    finish(0);
    assert(!held(ctrl) && held(shift));
    pointer(200, 100, 0);
    assert(XTestFakeKeyEvent(display, shift, False, CurrentTime));
    XSync(display, False); receive();
  }
  // Text cannot borrow a locally held modifier, even if all symbols exist.
  assert(XTestFakeKeyEvent(display, shift, True, CurrentTime));
  XSync(display, False); receive();
  previous_presses = presses;
  start(argv[1], false);
  const char *modified = "[{\"kind\":\"move\",\"x\":1,\"y\":1},{\"kind\":\"text\",\"text\":\"a\"}]\n";
  assert(write(input, modified, strlen(modified)) == (ssize_t)strlen(modified));
  finish(2);
  assert(held(shift) && presses == previous_presses);
  pointer(200, 100, 0);
  assert(XTestFakeKeyEvent(display, shift, False, CurrentTime));
  XSync(display, False); receive();

  // A second, locally held Shift is still protected when we own the first.
  KeyCode right_shift = XKeysymToKeycode(display, XK_Shift_R);
  assert(right_shift && right_shift != shift);
  start(argv[1], false);
  send_batch("[{\"kind\":\"key\",\"code\":\"ShiftLeft\",\"down\":true}]\n");
  assert(XTestFakeKeyEvent(display, right_shift, True, CurrentTime));
  XSync(display, False); receive();
  previous_presses = presses;
  const char *owned_and_local = "[{\"kind\":\"text\",\"text\":\"A\"}]\n";
  assert(write(input, owned_and_local, strlen(owned_and_local)) == (ssize_t)strlen(owned_and_local));
  finish(2);
  assert(!held(shift) && held(right_shift) && presses == previous_presses);
  assert(XTestFakeKeyEvent(display, right_shift, False, CurrentTime));
  XSync(display, False); receive();

  names->names->keys[b] = names->names->keys[a];
  names->names->keys[a] = original_a;
  assert(XkbSetNames(display, XkbKeyNamesMask, 0, 0, names));
  XkbFreeKeyboard(names, XkbAllComponentsMask, True);
  XFree(before);
  XDestroyWindow(display, window);
  XCloseDisplay(display);
  puts("X11 integration passed");
  return 0;
}
