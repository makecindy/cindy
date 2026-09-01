#include "switch2_usb.h"

#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/hid/IOHIDLib.h>
#include <IOKit/usb/IOUSBLib.h>

#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define NINTENDO_VID 0x057E
#define SWITCH2_PRO_PID 0x2069
#define SWITCH2_IFACE 1

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_t g_thread;
static bool g_thread_started = false;
static volatile bool g_stop = false;
static Switch2UsbState g_state;

static IOUSBInterfaceInterface **g_iface = NULL;
static UInt8 g_pipe_out = 0;
static UInt8 g_pipe_in = 0;
static IOHIDManagerRef g_hid_manager = NULL;
static uint8_t g_hid_buffer[128];

static double clamp_axis(double value) {
  if (value > -0.15 && value < 0.15) return 0;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

static double axis12(unsigned raw, bool invert) {
  double value = (raw / 4095.0) * 2.0 - 1.0;
  if (invert) value = -value;
  return clamp_axis(value);
}

static void parse_packet(const uint8_t *data, int size) {
  if (size < 17) return;
  Switch2UsbState next;
  memset(&next, 0, sizeof(next));
  next.present = true;
  snprintf(next.name, sizeof(next.name), "Pro Controller");
  next.x = (data[5] & 0x01) != 0;
  next.y = (data[5] & 0x02) != 0;
  next.a = (data[5] & 0x04) != 0;
  next.b = (data[5] & 0x08) != 0;
  next.rb = (data[5] & 0x40) != 0;
  next.rt = (data[5] & 0x80) != 0;
  next.view = (data[6] & 0x01) != 0;
  next.menu = (data[6] & 0x02) != 0;
  next.rs = (data[6] & 0x04) != 0;
  next.ls = (data[6] & 0x08) != 0;
  next.xbox = (data[6] & 0x10) != 0;
  next.dpad_down = (data[7] & 0x01) != 0;
  next.dpad_up = (data[7] & 0x02) != 0;
  next.dpad_right = (data[7] & 0x04) != 0;
  next.dpad_left = (data[7] & 0x08) != 0;
  next.lb = (data[7] & 0x40) != 0;
  next.lt = (data[7] & 0x80) != 0;
  next.lx = axis12((unsigned)(data[11] | ((data[12] & 0x0F) << 8)), false);
  next.ly = axis12((unsigned)((data[12] >> 4) | (data[13] << 4)), false);
  next.rx = axis12((unsigned)(data[14] | ((data[15] & 0x0F) << 8)), false);
  next.ry = axis12((unsigned)((data[15] >> 4) | (data[16] << 4)), false);
  pthread_mutex_lock(&g_lock);
  g_state = next;
  pthread_mutex_unlock(&g_lock);
}

static void hid_report(
  void *context,
  IOReturn result,
  void *sender,
  IOHIDReportType type,
  uint32_t report_id,
  uint8_t *report,
  CFIndex length
) {
  (void)context;
  (void)result;
  (void)sender;
  (void)type;
  if (length <= 0) return;
  uint8_t packet[64];
  memset(packet, 0, sizeof(packet));
  if (report_id != 0 && (length < 1 || report[0] != report_id)) {
    packet[0] = (uint8_t)report_id;
    CFIndex copy = length;
    if (copy > 63) copy = 63;
    memcpy(packet + 1, report, (size_t)copy);
    parse_packet(packet, (int)copy + 1);
  } else {
    CFIndex copy = length;
    if (copy > 64) copy = 64;
    memcpy(packet, report, (size_t)copy);
    parse_packet(packet, (int)copy);
  }
}

static void close_hid(void) {
  if (g_hid_manager) {
    IOHIDManagerUnscheduleFromRunLoop(g_hid_manager, CFRunLoopGetCurrent(), kCFRunLoopDefaultMode);
    IOHIDManagerClose(g_hid_manager, kIOHIDOptionsTypeNone);
    CFRelease(g_hid_manager);
    g_hid_manager = NULL;
  }
}

static bool open_hid(void) {
  close_hid();
  IOHIDManagerRef manager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
  if (!manager) return false;
  int vid = NINTENDO_VID;
  int pid = SWITCH2_PRO_PID;
  CFNumberRef vid_num = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &vid);
  CFNumberRef pid_num = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &pid);
  CFMutableDictionaryRef matching = CFDictionaryCreateMutable(
    kCFAllocatorDefault,
    0,
    &kCFTypeDictionaryKeyCallBacks,
    &kCFTypeDictionaryValueCallBacks
  );
  CFDictionarySetValue(matching, CFSTR(kIOHIDVendorIDKey), vid_num);
  CFDictionarySetValue(matching, CFSTR(kIOHIDProductIDKey), pid_num);
  CFRelease(vid_num);
  CFRelease(pid_num);
  IOHIDManagerSetDeviceMatching(manager, matching);
  CFRelease(matching);
  if (IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone) != kIOReturnSuccess) {
    CFRelease(manager);
    return false;
  }
  CFSetRef devices = IOHIDManagerCopyDevices(manager);
  if (!devices || CFSetGetCount(devices) == 0) {
    if (devices) CFRelease(devices);
    IOHIDManagerClose(manager, kIOHIDOptionsTypeNone);
    CFRelease(manager);
    return false;
  }
  IOHIDDeviceRef device = NULL;
  CFSetGetValues(devices, (const void **)&device);
  CFRelease(devices);
  IOHIDDeviceRegisterInputReportCallback(device, g_hid_buffer, sizeof(g_hid_buffer), hid_report, NULL);
  IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetCurrent(), kCFRunLoopDefaultMode);
  g_hid_manager = manager;
  return true;
}

static void close_iface(void) {
  close_hid();
  if (g_iface) {
    (*g_iface)->USBInterfaceClose(g_iface);
    (*g_iface)->Release(g_iface);
    g_iface = NULL;
  }
  g_pipe_in = 0;
  g_pipe_out = 0;
}

static int send_bulk(const uint8_t *data, UInt32 size) {
  if (!g_iface || !g_pipe_out) return -1;
  IOReturn kr = (*g_iface)->WritePipe(g_iface, g_pipe_out, (void *)data, size);
  return kr == kIOReturnSuccess ? (int)size : -1;
}

static int recv_bulk(uint8_t *data, UInt32 size, UInt32 timeout_ms) {
  if (!g_iface || !g_pipe_in) return -1;
  UInt32 remaining = size;
  IOReturn kr = (*g_iface)->ReadPipeTO(g_iface, g_pipe_in, data, &remaining, timeout_ms, timeout_ms);
  if (kr == kIOReturnSuccess) return (int)remaining;
  if (kr == kIOUSBTransactionTimeout) return 0;
  return -1;
}

static bool open_interface(io_service_t service) {
  IOCFPlugInInterface **plugin = NULL;
  SInt32 score = 0;
  IOReturn kr = IOCreatePlugInInterfaceForService(
    service,
    kIOUSBInterfaceUserClientTypeID,
    kIOCFPlugInInterfaceID,
    &plugin,
    &score
  );
  if (kr != kIOReturnSuccess || !plugin) return false;

  IOUSBInterfaceInterface **iface = NULL;
  HRESULT hr = (*plugin)->QueryInterface(
    plugin,
    CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID),
    (LPVOID *)&iface
  );
  (*plugin)->Release(plugin);
  if (hr != S_OK || !iface) return false;

  UInt8 number = 0;
  (*iface)->GetInterfaceNumber(iface, &number);
  if (number != SWITCH2_IFACE) {
    (*iface)->Release(iface);
    return false;
  }

  kr = (*iface)->USBInterfaceOpen(iface);
  if (kr != kIOReturnSuccess) {
    (*iface)->Release(iface);
    return false;
  }

  UInt8 pipes = 0;
  (*iface)->GetNumEndpoints(iface, &pipes);
  UInt8 pipe_in = 0;
  UInt8 pipe_out = 0;
  for (UInt8 pipe = 1; pipe <= pipes; pipe++) {
    UInt8 direction = 0;
    UInt8 ep_number = 0;
    UInt8 transfer = 0;
    UInt8 interval = 0;
    UInt16 max_packet = 0;
    kr = (*iface)->GetPipeProperties(iface, pipe, &direction, &ep_number, &transfer, &max_packet, &interval);
    if (kr != kIOReturnSuccess) continue;
    if (transfer != kUSBBulk) continue;
    if (direction == kUSBIn) pipe_in = pipe;
    if (direction == kUSBOut) pipe_out = pipe;
  }
  if (!pipe_in || !pipe_out) {
    (*iface)->USBInterfaceClose(iface);
    (*iface)->Release(iface);
    return false;
  }

  g_iface = iface;
  g_pipe_in = pipe_in;
  g_pipe_out = pipe_out;
  return true;
}

static bool open_device(void) {
  close_iface();
  CFMutableDictionaryRef matching = IOServiceMatching("IOUSBHostDevice");
  if (!matching) matching = IOServiceMatching(kIOUSBDeviceClassName);
  if (!matching) return false;
  int vid = NINTENDO_VID;
  int pid = SWITCH2_PRO_PID;
  CFNumberRef vid_num = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &vid);
  CFNumberRef pid_num = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &pid);
  CFDictionarySetValue(matching, CFSTR(kUSBVendorID), vid_num);
  CFDictionarySetValue(matching, CFSTR(kUSBProductID), pid_num);
  CFRelease(vid_num);
  CFRelease(pid_num);

  io_iterator_t iterator = 0;
  kern_return_t kr = IOServiceGetMatchingServices(kIOMasterPortDefault, matching, &iterator);
  if (kr != KERN_SUCCESS) {
    return false;
  }

  bool opened = false;
  io_service_t device;
  int seen = 0;
  while ((device = IOIteratorNext(iterator))) {
    seen += 1;
    IOCFPlugInInterface **plugin = NULL;
    SInt32 score = 0;
    kr = IOCreatePlugInInterfaceForService(
      device,
      kIOUSBDeviceUserClientTypeID,
      kIOCFPlugInInterfaceID,
      &plugin,
      &score
    );
    IOObjectRelease(device);
    if (kr != kIOReturnSuccess || !plugin) {
      continue;
    }

    IOUSBDeviceInterface **usb = NULL;
    HRESULT hr = (*plugin)->QueryInterface(
      plugin,
      CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID),
      (LPVOID *)&usb
    );
    (*plugin)->Release(plugin);
    if (hr != S_OK || !usb) {
      continue;
    }

    IOReturn device_open = (*usb)->USBDeviceOpenSeize(usb);
    if (device_open != kIOReturnSuccess) {
      device_open = (*usb)->USBDeviceOpen(usb);
    }
    if (device_open != kIOReturnSuccess) {
      (*usb)->Release(usb);
      continue;
    }

    IOUSBFindInterfaceRequest req;
    req.bInterfaceClass = kIOUSBFindInterfaceDontCare;
    req.bInterfaceSubClass = kIOUSBFindInterfaceDontCare;
    req.bInterfaceProtocol = kIOUSBFindInterfaceDontCare;
    req.bAlternateSetting = kIOUSBFindInterfaceDontCare;
    io_iterator_t ifaces = 0;
    kr = (*usb)->CreateInterfaceIterator(usb, &req, &ifaces);
    (*usb)->Release(usb);
    if (kr != kIOReturnSuccess) continue;

    io_service_t iface_service;
    while ((iface_service = IOIteratorNext(ifaces))) {
      if (open_interface(iface_service)) opened = true;
      IOObjectRelease(iface_service);
      if (opened) break;
    }
    IOObjectRelease(ifaces);
    if (opened) break;
  }
  IOObjectRelease(iterator);
  return opened;
}

static bool send_init(void) {
  static const uint8_t pkt0[] = { 0x07, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00 };
  static const uint8_t pkt1[] = { 0x0c, 0x91, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x27, 0x00, 0x00, 0x00 };
  static const uint8_t pkt2[] = { 0x11, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00 };
  static const uint8_t pkt3[] = {
    0x0a, 0x91, 0x00, 0x08, 0x00, 0x14, 0x00, 0x00,
    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0x35, 0x00, 0x46, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  };
  static const uint8_t pkt4[] = { 0x0c, 0x91, 0x00, 0x04, 0x00, 0x04, 0x00, 0x00, 0x27, 0x00, 0x00, 0x00 };
  static const uint8_t pkt5[] = { 0x01, 0x91, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x00 };
  static const uint8_t pkt6[] = { 0x01, 0x91, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00 };
  static const uint8_t pkt7[] = { 0x08, 0x91, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00 };
  static const uint8_t pkt8[] = { 0x03, 0x91, 0x00, 0x0a, 0x00, 0x04, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00 };
  static const uint8_t pkt9[] = {
    0x03, 0x91, 0x00, 0x0d, 0x00, 0x08, 0x00, 0x00,
    0x01, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  };
  const uint8_t *packets[] = { pkt0, pkt1, pkt2, pkt3, pkt4, pkt5, pkt6, pkt7, pkt8, pkt9 };
  const size_t sizes[] = {
    sizeof(pkt0), sizeof(pkt1), sizeof(pkt2), sizeof(pkt3), sizeof(pkt4),
    sizeof(pkt5), sizeof(pkt6), sizeof(pkt7), sizeof(pkt8), sizeof(pkt9),
  };
  uint8_t reply[64];
  for (size_t i = 0; i < sizeof(packets) / sizeof(packets[0]); i++) {
    if (send_bulk(packets[i], (UInt32)sizes[i]) < 0) return false;
    (void)recv_bulk(reply, sizeof(reply), 200);
  }
  return true;
}

static void mark_absent(void) {
  pthread_mutex_lock(&g_lock);
  memset(&g_state, 0, sizeof(g_state));
  pthread_mutex_unlock(&g_lock);
}

static void *poll_thread(void *arg) {
  (void)arg;
  while (!g_stop) {
    if (!g_iface) {
      if (!open_device() || !send_init()) {
        close_iface();
        mark_absent();
        usleep(500 * 1000);
        continue;
      }
      (void)open_hid();
    }
    uint8_t packet[64];
    int n = recv_bulk(packet, sizeof(packet), 20);
    if (n < 0) {
      close_iface();
      mark_absent();
      continue;
    }
    if (n >= 17) parse_packet(packet, n);
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true);
  }
  close_iface();
  mark_absent();
  return NULL;
}

bool switch2_usb_ensure(void) {
  pthread_mutex_lock(&g_lock);
  if (g_thread_started) {
    pthread_mutex_unlock(&g_lock);
    return true;
  }
  g_stop = false;
  memset(&g_state, 0, sizeof(g_state));
  if (pthread_create(&g_thread, NULL, poll_thread, NULL) != 0) {
    pthread_mutex_unlock(&g_lock);
    return false;
  }
  g_thread_started = true;
  pthread_mutex_unlock(&g_lock);
  return true;
}

void switch2_usb_copy_state(Switch2UsbState *out) {
  pthread_mutex_lock(&g_lock);
  *out = g_state;
  pthread_mutex_unlock(&g_lock);
}

void switch2_usb_shutdown(void) {
  pthread_mutex_lock(&g_lock);
  if (!g_thread_started) {
    pthread_mutex_unlock(&g_lock);
    return;
  }
  g_stop = true;
  pthread_t thread = g_thread;
  g_thread_started = false;
  pthread_mutex_unlock(&g_lock);
  pthread_join(thread, NULL);
  close_iface();
  mark_absent();
}
