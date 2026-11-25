/* GNOME Shell (Mutter) Wayland input through Mutter's own RemoteDesktop
 * D-Bus API, as GNOME's remote desktop uses it. A screen-cast stream of the
 * selected monitor anchors absolute pointer coordinates; its video is never
 * read. GNOME shows its remote-control indicator while the session runs.
 * No portal, uinput, root service or input logging. */
#include <gio/gio.h>

#define GNOME_RD "org.gnome.Mutter.RemoteDesktop"
#define GNOME_RD_SESSION "org.gnome.Mutter.RemoteDesktop.Session"
#define GNOME_SC "org.gnome.Mutter.ScreenCast"
#define GNOME_SC_SESSION "org.gnome.Mutter.ScreenCast.Session"
static GDBusConnection *gnome_bus;
static char *gnome_session, *gnome_stream;
static double gnome_width, gnome_height, gnome_wheel_x, gnome_wheel_y;
static volatile int gnome_closed;

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
/* Mutter resolves each keysym against its own keymap, without changing the
 * user's layout or the clipboard. */
static bool gnome_text(const char *text) {
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
