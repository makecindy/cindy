#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  bool present;
  char name[64];
  bool a;
  bool b;
  bool x;
  bool y;
  bool lb;
  bool rb;
  bool lt;
  bool rt;
  bool view;
  bool menu;
  bool xbox;
  bool ls;
  bool rs;
  bool dpad_up;
  bool dpad_down;
  bool dpad_left;
  bool dpad_right;
  double lx;
  double ly;
  double rx;
  double ry;
} Switch2UsbState;

/** Open the Switch 2 Pro over USB bulk, send SDL's init sequence, and start polling. */
bool switch2_usb_ensure(void);

/** Copy the latest parsed state. present=false if the pad is gone. */
void switch2_usb_copy_state(Switch2UsbState *out);

void switch2_usb_shutdown(void);

#ifdef __cplusplus
}
#endif
