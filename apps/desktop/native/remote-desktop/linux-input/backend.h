#ifndef CINDY_INPUT_BACKEND_H
#define CINDY_INPUT_BACKEND_H
#include <stdbool.h>
#include <stdint.h>
#include <signal.h>

// One backend per binary. Protocol validation and watchdog belong to main.c.
// Geometry is in root-window pixels; normalized endpoints select first/last pixel.
struct geometry { int x, y, width, height; bool supplied; };
extern volatile sig_atomic_t stopping;
uint32_t codepoint(const unsigned char **cursor);
bool backend_open(bool check, const struct geometry *geometry);
int backend_fd(void);
// Safe without a readable fd: process available events and refresh backend state.
bool backend_dispatch(void);
bool backend_sync(void);
bool backend_key_available(uint32_t code);
bool backend_key(uint32_t code, bool down);
bool backend_pointer(double x, double y, int button, bool down);
bool backend_scroll(double dx, double dy);
bool backend_text_available(const char *text);
bool backend_text(const char *text);
void backend_release(void);
void backend_close(void);
#endif
