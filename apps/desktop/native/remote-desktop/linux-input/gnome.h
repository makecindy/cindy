/* GNOME Shell (Mutter) Wayland input through Mutter's own RemoteDesktop
 * D-Bus API, as GNOME's remote desktop uses it. A screen-cast stream of the
 * selected monitor anchors absolute pointer coordinates; its video is never
 * read. GNOME shows its remote-control indicator while the session runs.
 * No portal, uinput, root service or input logging. */
#include <fcntl.h>
#include <gio/gio.h>
#include <gio/gunixfdlist.h>

#define GNOME_RD "org.gnome.Mutter.RemoteDesktop"
#define GNOME_RD_SESSION "org.gnome.Mutter.RemoteDesktop.Session"
#define GNOME_SC "org.gnome.Mutter.ScreenCast"
#define GNOME_SC_SESSION "org.gnome.Mutter.ScreenCast.Session"
static GDBusConnection *gnome_bus;
static char *gnome_session, *gnome_stream;
static double gnome_width, gnome_height, gnome_wheel_x, gnome_wheel_y;
static volatile int gnome_closed;
/* Clipboard state for text outside the keyboard layout (see gnome_paste). */
#define GNOME_SAVED_TYPES 16
#define GNOME_SAVED_BYTES (8 << 20)
static bool gnome_clipboard, gnome_session_owns;
static char **gnome_owner_types; /* the current non-Cindy owner's offer */
static struct {
  char *type;
  unsigned char *data;
  size_t size;
} gnome_saved[GNOME_SAVED_TYPES];
static int gnome_saved_count;
static const char *gnome_text_offer; /* non-NULL while our text is offered */
static size_t gnome_text_size;
static unsigned gnome_transfers;

static GVariant *gnome_call(const char *name, const char *path,
                            const char *iface, const char *method,
                            GVariant *args, const char *type) {
  GError *error = NULL;
  GVariant *result = g_dbus_connection_call_sync(
      gnome_bus, name, path, iface, method, args,
      type ? G_VARIANT_TYPE(type) : NULL, G_DBUS_CALL_FLAGS_NONE, 3000, NULL,
      &error);
  if (error)
    g_error_free(error);
  return result;
}
/* Each notification is a synchronous call: Mutter applies them in order, and
 * the batch acknowledgement means every event was accepted. */
static bool gnome_notify(const char *method, GVariant *args) {
  if (gnome_closed)
    return false;
  GVariant *reply =
      gnome_call(GNOME_RD, gnome_session, GNOME_RD_SESSION, method, args, NULL);
  if (!reply)
    return false;
  g_variant_unref(reply);
  return true;
}
static GVariant *gnome_property(const char *name, const char *path,
                                const char *iface, const char *property) {
  GVariant *reply =
      gnome_call(name, path, "org.freedesktop.DBus.Properties", "Get",
                 g_variant_new("(ss)", iface, property), "(v)");
  if (!reply)
    return NULL;
  GVariant *value;
  g_variant_get(reply, "(v)", &value);
  g_variant_unref(reply);
  return value;
}
static void gnome_on_closed(GDBusConnection *connection, const gchar *sender,
                            const gchar *path, const gchar *iface,
                            const gchar *signal, GVariant *parameters,
                            gpointer data) {
  (void)connection;
  (void)sender;
  (void)path;
  (void)iface;
  (void)signal;
  (void)parameters;
  (void)data;
  gnome_closed = 1;
  stopping = 1;
}
static const char *const gnome_text_types[] = {
    "text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"};
static void gnome_on_owner(GDBusConnection *connection, const gchar *sender,
                           const gchar *path, const gchar *iface,
                           const gchar *signal, GVariant *parameters,
                           gpointer data) {
  (void)connection;
  (void)sender;
  (void)path;
  (void)iface;
  (void)signal;
  (void)data;
  GVariant *options = NULL;
  g_variant_get(parameters, "(@a{sv})", &options);
  gboolean ours = FALSE;
  g_variant_lookup(options, "session-is-owner", "b", &ours);
  gnome_session_owns = ours;
  if (!ours) {
    /* Another application copied something: that is what to restore. */
    g_strfreev(gnome_owner_types);
    gnome_owner_types = NULL;
    /* GNOME 46 wraps the list as (as); accept a bare as as well. */
    GVariant *types = g_variant_lookup_value(options, "mime-types", NULL);
    if (types && g_variant_is_of_type(types, G_VARIANT_TYPE("(as)"))) {
      GVariant *inner = g_variant_get_child_value(types, 0);
      g_variant_unref(types);
      types = inner;
    }
    if (types && g_variant_is_of_type(types, G_VARIANT_TYPE_STRING_ARRAY))
      gnome_owner_types = g_variant_dup_strv(types, NULL);
    if (types)
      g_variant_unref(types);
    for (int i = 0; i < gnome_saved_count; i++) {
      g_free(gnome_saved[i].type);
      g_free(gnome_saved[i].data);
    }
    gnome_saved_count = 0;
  }
  g_variant_unref(options);
}
static int gnome_fd_call(const char *method, GVariant *args) {
  GUnixFDList *fds = NULL;
  GVariant *reply = g_dbus_connection_call_with_unix_fd_list_sync(
      gnome_bus, GNOME_RD, gnome_session, GNOME_RD_SESSION, method, args,
      G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NONE, 3000, NULL, &fds, NULL,
      NULL);
  int fd = -1;
  if (reply && fds) {
    gint32 index;
    g_variant_get(reply, "(h)", &index);
    fd = g_unix_fd_list_get(fds, index, NULL);
  }
  if (reply)
    g_variant_unref(reply);
  if (fds)
    g_object_unref(fds);
  return fd;
}
/* An application pasted (or GNOME's clipboard manager cached) our offer. */
static void gnome_on_transfer(GDBusConnection *connection, const gchar *sender,
                              const gchar *path, const gchar *iface,
                              const gchar *signal, GVariant *parameters,
                              gpointer data) {
  (void)connection;
  (void)sender;
  (void)path;
  (void)iface;
  (void)signal;
  (void)data;
  const char *type;
  guint32 serial;
  g_variant_get(parameters, "(&su)", &type, &serial);
  const unsigned char *bytes = NULL;
  size_t size = 0;
  if (gnome_text_offer) {
    for (size_t i = 0; i < G_N_ELEMENTS(gnome_text_types); i++)
      if (!strcmp(type, gnome_text_types[i])) {
        bytes = (const unsigned char *)gnome_text_offer;
        size = gnome_text_size;
      }
  } else
    for (int i = 0; i < gnome_saved_count; i++)
      if (!strcmp(type, gnome_saved[i].type)) {
        bytes = gnome_saved[i].data;
        size = gnome_saved[i].size;
      }
  bool ok = false;
  if (bytes) {
    int fd = gnome_fd_call("SelectionWrite", g_variant_new("(u)", serial));
    if (fd >= 0) {
      ok = true;
      for (size_t done = 0; done < size && ok;) {
        ssize_t n = write(fd, bytes + done, size - done);
        if (n < 0 && errno == EINTR)
          continue;
        ok = n > 0;
        done += n > 0 ? (size_t)n : 0;
      }
      close(fd);
    }
  }
  GVariant *reply =
      gnome_call(GNOME_RD, gnome_session, GNOME_RD_SESSION, "SelectionWriteDone",
                 g_variant_new("(ub)", serial, ok), NULL);
  if (reply)
    g_variant_unref(reply);
  gnome_transfers++;
}
static void gnome_pump(int milliseconds) {
  gint64 until = g_get_monotonic_time() + (gint64)milliseconds * 1000;
  while (g_get_monotonic_time() < until && !gnome_closed && !stopping) {
    while (g_main_context_iteration(NULL, FALSE))
      ;
    struct timespec pause = {.tv_nsec = 5000000};
    nanosleep(&pause, NULL);
  }
}
/* Read one offered type of the current clipboard, bounded in size and time. */
static bool gnome_read_type(const char *type, size_t limit, unsigned char **out,
                            size_t *size) {
  int fd = gnome_fd_call("SelectionRead", g_variant_new("(s)", type));
  if (fd < 0)
    return false;
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  GByteArray *bytes = g_byte_array_new();
  gint64 until = g_get_monotonic_time() + 500000;
  bool ok = false;
  for (;;) {
    unsigned char chunk[65536];
    ssize_t n = read(fd, chunk, sizeof(chunk));
    if (n > 0) {
      g_byte_array_append(bytes, chunk, (guint)n);
      if (bytes->len > limit)
        break;
      continue;
    }
    if (n == 0) {
      ok = true;
      break;
    }
    if (errno != EAGAIN && errno != EINTR)
      break;
    gint64 left = until - g_get_monotonic_time();
    if (left <= 0)
      break;
    /* The owner writes through Mutter's main loop; keep our signals flowing. */
    while (g_main_context_iteration(NULL, FALSE))
      ;
    struct pollfd wait = {fd, POLLIN, 0};
    poll(&wait, 1, (int)(left / 1000 < 20 ? left / 1000 + 1 : 20));
  }
  close(fd);
  *size = bytes->len;
  *out = g_byte_array_free(bytes, FALSE);
  if (!ok) {
    g_free(*out);
    *out = NULL;
  }
  return ok;
}
static bool gnome_offer(const char *const *types, size_t count) {
  GVariantBuilder options;
  g_variant_builder_init(&options, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&options, "{sv}", "mime-types",
                        g_variant_new_strv((const gchar *const *)types,
                                           (gssize)count));
  return gnome_notify("SetSelection", g_variant_new("(a{sv})", &options));
}
/* Mutter types only keysyms present in the active layout, so other text
 * (Chinese, emoji) is pasted: save the user's clipboard (up to 16 types and
 * 8 MiB, in memory only), offer the text, press Shift+Insert (Ctrl+V would be
 * literal input in terminals), then offer the saved contents again. Mutter's
 * clipboard manager keeps them after this session ends. */
static bool gnome_paste(const char *text) {
  if (!gnome_clipboard) {
    GVariantBuilder options;
    g_variant_builder_init(&options, G_VARIANT_TYPE("a{sv}"));
    if (!gnome_notify("EnableClipboard", g_variant_new("(a{sv})", &options)))
      return false;
    gnome_clipboard = true;
    gnome_pump(100); /* the current owner's offer arrives as a signal */
  }
  /* Our own restored offer already holds the user's clipboard. */
  if (!gnome_session_owns && gnome_owner_types && !gnome_saved_count) {
    size_t total = 0;
    for (char **type = gnome_owner_types;
         *type && gnome_saved_count < GNOME_SAVED_TYPES; type++) {
      /* X11 selection bookkeeping targets carry no content. */
      if (!strcmp(*type, "TARGETS") || !strcmp(*type, "MULTIPLE") ||
          !strcmp(*type, "TIMESTAMP") || !strcmp(*type, "SAVE_TARGETS"))
        continue;
      unsigned char *data;
      size_t size;
      if (!gnome_read_type(*type, GNOME_SAVED_BYTES - total, &data, &size))
        continue;
      gnome_saved[gnome_saved_count].type = g_strdup(*type);
      gnome_saved[gnome_saved_count].data = data;
      gnome_saved[gnome_saved_count].size = size;
      gnome_saved_count++;
      total += size;
    }
  }
  gnome_text_offer = text;
  gnome_text_size = strlen(text);
  bool ok = gnome_offer(gnome_text_types, G_N_ELEMENTS(gnome_text_types));
  /* Serve any eager clipboard-manager read before counting the paste. */
  gnome_pump(30);
  unsigned before = gnome_transfers;
  ok = ok && gnome_notify("NotifyKeyboardKeycode", g_variant_new("(ub)", 42, TRUE)) &&
       gnome_notify("NotifyKeyboardKeycode", g_variant_new("(ub)", 110, TRUE)) &&
       gnome_notify("NotifyKeyboardKeycode", g_variant_new("(ub)", 110, FALSE)) &&
       gnome_notify("NotifyKeyboardKeycode", g_variant_new("(ub)", 42, FALSE));
  /* Wait for the focused application's read, then a short grace for others. */
  for (int waited = 0; ok && gnome_transfers == before && waited < 1500;
       waited += 10)
    gnome_pump(10);
  if (ok)
    gnome_pump(150);
  gnome_text_offer = NULL;
  if (gnome_saved_count) {
    const char *types[GNOME_SAVED_TYPES];
    for (int i = 0; i < gnome_saved_count; i++)
      types[i] = gnome_saved[i].type;
    ok = gnome_offer(types, (size_t)gnome_saved_count) && ok;
  }
  return ok;
}
static bool gnome_valid_connector(const char *name) {
  size_t n = strlen(name);
  if (!n || n > 80)
    return false;
  for (size_t i = 0; i < n; i++)
    if (!(g_ascii_isalnum(name[i]) || strchr("_.-", name[i])))
      return false;
  return true;
}
/* NULL connector only probes the interfaces; no session is created. */
static bool gnome_open(const char *connector) {
  const char *type = getenv("XDG_SESSION_TYPE");
  const char *wayland = getenv("WAYLAND_DISPLAY");
  if (!(type && !strcmp(type, "wayland")) && !(wayland && *wayland))
    return false;
  if (connector && !gnome_valid_connector(connector))
    return false;
  gnome_bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
  if (!gnome_bus)
    return false;
  if (!connector) {
    GVariant *types = gnome_property(GNOME_RD, "/org/gnome/Mutter/RemoteDesktop",
                                     GNOME_RD, "SupportedDeviceTypes");
    guint32 supported = 0;
    if (types && g_variant_is_of_type(types, G_VARIANT_TYPE_UINT32))
      supported = g_variant_get_uint32(types);
    if (types)
      g_variant_unref(types);
    GVariant *version =
        gnome_property(GNOME_SC, "/org/gnome/Mutter/ScreenCast", GNOME_SC,
                       "Version");
    bool screen_cast = version != NULL;
    if (version)
      g_variant_unref(version);
    /* Keyboard (1) and pointer (2). */
    return screen_cast && (supported & 3) == 3;
  }
  GVariant *reply = gnome_call(GNOME_RD, "/org/gnome/Mutter/RemoteDesktop",
                               GNOME_RD, "CreateSession", NULL, "(o)");
  if (!reply)
    return false;
  g_variant_get(reply, "(o)", &gnome_session);
  g_variant_unref(reply);
  g_dbus_connection_signal_subscribe(gnome_bus, GNOME_RD, GNOME_RD_SESSION,
                                     "Closed", gnome_session, NULL,
                                     G_DBUS_SIGNAL_FLAGS_NONE, gnome_on_closed,
                                     NULL, NULL);
  g_dbus_connection_signal_subscribe(
      gnome_bus, GNOME_RD, GNOME_RD_SESSION, "SelectionOwnerChanged",
      gnome_session, NULL, G_DBUS_SIGNAL_FLAGS_NONE, gnome_on_owner, NULL, NULL);
  g_dbus_connection_signal_subscribe(
      gnome_bus, GNOME_RD, GNOME_RD_SESSION, "SelectionTransfer", gnome_session,
      NULL, G_DBUS_SIGNAL_FLAGS_NONE, gnome_on_transfer, NULL, NULL);
  GVariant *id =
      gnome_property(GNOME_RD, gnome_session, GNOME_RD_SESSION, "SessionId");
  if (!id || !g_variant_is_of_type(id, G_VARIANT_TYPE_STRING)) {
    if (id)
      g_variant_unref(id);
    return false;
  }
  GVariantBuilder options;
  g_variant_builder_init(&options, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&options, "{sv}", "remote-desktop-session-id", id);
  reply = gnome_call(GNOME_SC, "/org/gnome/Mutter/ScreenCast", GNOME_SC,
                     "CreateSession", g_variant_new("(a{sv})", &options),
                     "(o)");
  if (!reply)
    return false;
  const char *cast;
  g_variant_get(reply, "(&o)", &cast);
  g_variant_builder_init(&options, G_VARIANT_TYPE("a{sv}"));
  /* The stream only anchors coordinates; it carries no pointer either. */
  g_variant_builder_add(&options, "{sv}", "cursor-mode",
                        g_variant_new_uint32(0));
  GVariant *stream =
      gnome_call(GNOME_SC, cast, GNOME_SC_SESSION, "RecordMonitor",
                 g_variant_new("(sa{sv})", connector, &options), "(o)");
  g_variant_unref(reply);
  if (!stream)
    return false;
  g_variant_get(stream, "(o)", &gnome_stream);
  g_variant_unref(stream);
  if (!gnome_notify("Start", NULL))
    return false;
  /* Stream geometry is published once the session has started. */
  for (int attempt = 0; attempt < 100 && !gnome_closed; attempt++) {
    GVariant *parameters =
        gnome_property(GNOME_SC, gnome_stream,
                       "org.gnome.Mutter.ScreenCast.Stream", "Parameters");
    gint32 width = 0, height = 0;
    if (parameters && g_variant_is_of_type(parameters, G_VARIANT_TYPE_VARDICT))
      g_variant_lookup(parameters, "size", "(ii)", &width, &height);
    if (parameters)
      g_variant_unref(parameters);
    if (width > 0 && height > 0 && width <= 32767 && height <= 32767) {
      gnome_width = width;
      gnome_height = height;
      return true;
    }
    while (g_main_context_iteration(NULL, FALSE))
      ;
    struct timespec pause = {.tv_nsec = 10000000};
    nanosleep(&pause, NULL);
  }
  return false;
}
static bool gnome_move(double x, double y) {
  return gnome_notify("NotifyPointerMotionAbsolute",
                      g_variant_new("(sdd)", gnome_stream,
                                    x * (gnome_width - 1),
                                    y * (gnome_height - 1)));
}
static bool gnome_button(uint32_t code, bool down) {
  return gnome_notify("NotifyPointerButton",
                      g_variant_new("(ib)", (gint32)code, down));
}
static bool gnome_key(uint32_t code, bool down) {
  return gnome_notify("NotifyKeyboardKeycode", g_variant_new("(ub)", code, down));
}
/* Same 40-unit wheel steps as the X11 backend; positive is down / right. */
static bool gnome_wheel(double *remainder, double delta, guint32 axis) {
  *remainder += delta;
  while (fabs(*remainder) >= 40) {
    int step = *remainder < 0 ? -1 : 1;
    if (!gnome_notify("NotifyPointerAxisDiscrete",
                      g_variant_new("(ui)", axis, step)))
      return false;
    *remainder -= step * 40;
  }
  return true;
}
static bool gnome_scroll(double dx, double dy) {
  return gnome_wheel(&gnome_wheel_x, dx, 1) && gnome_wheel(&gnome_wheel_y, dy, 0);
}
/* ASCII is typed: Mutter resolves each keysym against its own keymap without
 * changing the user's layout or the clipboard. A commit containing anything
 * else is pasted whole (gnome_paste), keeping its order and one paste each. */
static bool gnome_text(const char *text) {
  for (const unsigned char *c = (const unsigned char *)text; *c; c++)
    if (*c >= 0x80)
      return gnome_paste(text);
  const unsigned char *p = (const unsigned char *)text;
  while (*p && !stopping) {
    uint32_t c = codepoint(&p);
    uint32_t sym = c == '\n' || c == '\r' ? 0xff0d
                   : c == '\t'            ? 0xff09
                   : c < 256              ? c
                                          : 0x01000000u | c;
    if (!gnome_notify("NotifyKeyboardKeysym", g_variant_new("(ub)", sym, TRUE)) ||
        !gnome_notify("NotifyKeyboardKeysym", g_variant_new("(ub)", sym, FALSE)))
      return false;
  }
  return !stopping;
}
static void gnome_close(void) {
  for (int i = 0; i < gnome_saved_count; i++) {
    g_free(gnome_saved[i].type);
    g_free(gnome_saved[i].data);
  }
  gnome_saved_count = 0;
  g_strfreev(gnome_owner_types);
  gnome_owner_types = NULL;
  if (gnome_session && !gnome_closed) {
    GVariant *reply = gnome_call(GNOME_RD, gnome_session, GNOME_RD_SESSION,
                                 "Stop", NULL, NULL);
    if (reply)
      g_variant_unref(reply);
  }
  g_free(gnome_session);
  g_free(gnome_stream);
  gnome_session = gnome_stream = NULL;
  if (gnome_bus)
    g_object_unref(gnome_bus);
  gnome_bus = NULL;
}
