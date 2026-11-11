#include "gate.hpp"
#include "privacy-artwork.hpp"
#include <chrono>
#include <dlfcn.h>
#include <hyprland/src/Compositor.hpp>
#include <hyprland/src/managers/input/InputManager.hpp>
#include <hyprland/src/plugins/PluginAPI.hpp>
#include <hyprland/src/pointer/PointerManager.hpp>
#include <hyprland/src/pointer/cursor/CursorManager.hpp>
#include <hyprland/src/render/OpenGL.hpp>
#include <hyprland/src/render/Renderer.hpp>
#include <hyprland/src/state/MonitorState.hpp>
#include <json-c/json.h>
#include <linux/input-event-codes.h>
#include <unistd.h>

using namespace Render;
using namespace Render::GL;
using Monitor::CMonitor;
static std::string stringValue(json_object *value) {
  if (!value || !json_object_is_type(value, json_type_string))
    throw std::runtime_error("string");
  std::string result = json_object_get_string(value);
  if (result.size() != static_cast<size_t>(json_object_get_string_len(value)))
    throw std::runtime_error("nul");
  return result;
}
static HANDLE owner;
static PrivacyGate gate;
static bool retired = false;
static bool loading = true;
static std::string token;
static std::chrono::steady_clock::time_point heartbeat;
static wl_event_source *watchdog = nullptr;
static SP<SHyprCtlCommand> command;
static std::vector<CHyprSignalListener> listeners;
static CFunctionHook *copyHook, *needsCopyHook, *keyHook, *modHook, *buttonHook, *axisHook,
    *moveHook, *warpHook, *scanoutHook;
static CFunctionHook *sharedModsHook, *allModsHook, *sharedKeysHook;
static CFunctionHook *cursorRenderHook, *cursorClearHook, *cursorReadHook;
static bool renderingCursor = false, cursorAllowed = false;
static WP<IFramebuffer> cursorFramebuffer;
static CFunctionHook *cursorConstraintsHook;
static void (*sendCursorEvents)(void *);
static CFunctionHook *softwareCursorHook;
static CRenderPass deferredCursor;
static PHLMONITORREF deferredCursorMonitor;
static void mirroredCursor() {
  auto monitor = g_pHyprRenderer->m_renderData.pMonitor.lock();
  if (!monitor || !monitor->m_mirrorOf || !g_pHyprRenderer->shouldRenderCursor())
    return;
  auto source = monitor->m_mirrorOf.lock();
  auto texture = Pointer::mgr()->getCurrentCursorTexture();
  if (!texture)
    return;
  // Mirrors now receive a cursor-free source too. Restore their visible cursor
  // using the same centered aspect-fit placement as the mirrored desktop.
  auto box = Pointer::mgr()->getCursorBoxGlobal();
  if (!box.overlaps(CBox{source->m_position, source->m_size}))
    return;
  const double fit = std::min(monitor->m_transformedSize.x / source->m_transformedSize.x,
                              monitor->m_transformedSize.y / source->m_transformedSize.y);
  box.translate(-source->m_position).scale(source->m_scale * fit)
      .translate((monitor->m_transformedSize - source->m_transformedSize * fit) / 2);
  if (!texture->m_imageDescription)
    texture->m_imageDescription = NColorManagement::DEFAULT_SRGB_IMAGE_DESCRIPTION;
  auto element = makeUnique<CTexPassElement>(CTexPassElement::SRenderData{.tex = texture, .box = box.round()});
  if (monitor->needsACopyFB()) {
    deferredCursor.clear();
    deferredCursorMonitor = monitor;
    deferredCursor.add(std::move(element));
  } else
    g_pHyprRenderer->m_renderPass.add(std::move(element));
}
static void softwareCursor(Pointer::CPointerManager *self, PHLMONITOR monitor,
                           const Time::steady_tp &now, CRegion &damage,
                           std::optional<Vector2D> position, bool screencopy,
                           bool force) {
  auto original = reinterpret_cast<void (*)(
      Pointer::CPointerManager *, PHLMONITOR, const Time::steady_tp &, CRegion &,
      std::optional<Vector2D>, bool, bool)>(softwareCursorHook->m_original);
  if (screencopy) {
    // The mirror no longer contains a software cursor. Explicit overlay
    // requests must draw one, just like hardware-cursor captures do.
    original(self, monitor, now, damage, position, true, true);
    return;
  }
  if (!monitor->needsACopyFB()) {
    original(self, monitor, now, damage, position, false, force);
    return;
  }
  deferredCursor.clear();
  deferredCursorMonitor = monitor;
  if (auto texture = self->getCurrentCursorTexture();
      texture && !texture->m_imageDescription)
    texture->m_imageDescription = NColorManagement::DEFAULT_SRGB_IMAGE_DESCRIPTION;
  std::swap(deferredCursor, g_pHyprRenderer->m_renderPass);
  original(self, monitor, now, damage, position, false, force);
  std::swap(deferredCursor, g_pHyprRenderer->m_renderPass);
}
static void cursorConstraints(void *session) {
  // The cursor shape change can finish a pending frame before the next output
  // commit. Send its hotspot before ready, as the Wayland protocol requires.
  sendCursorEvents(session);
  reinterpret_cast<void (*)(void *)>(cursorConstraintsHook->m_original)(session);
}
// Keep Hyprland's permission and source-overlap decision. Its opaque clear is
// the denied/outside-source path; a transparent clear can be a system cursor
// incorrectly classified as hidden because it has no wl_surface.
static void renderCursor(void *session) {
  const bool previous = renderingCursor;
  renderingCursor = true;
  cursorAllowed = true;
  cursorFramebuffer = g_pHyprRenderer->m_renderData.outFB;
  reinterpret_cast<void (*)(void *)>(cursorRenderHook->m_original)(session);
  renderingCursor = previous;
}
static void clearCursor(IHyprRenderer *renderer,
                        const CClearPassElement::SClearData &data,
                        const CRegion &damage) {
  reinterpret_cast<void (*)(
      IHyprRenderer *, const CClearPassElement::SClearData &, const CRegion &)>(
      cursorClearHook->m_original)(renderer, data, damage);
  if (renderingCursor && data.color.a != 0)
    cursorAllowed = false;
}
static bool readCursor(void *fb, CHLBufferReference buffer, uint32_t x,
                       uint32_t y, uint32_t width, uint32_t height) {
  const auto &cursor = Pointer::mgr()->currentCursorImage();
  const bool cursorRead = cursorFramebuffer.lock().get() == fb;
  if (cursorRead)
    cursorFramebuffer.reset();
  if (cursorRead && cursorAllowed && cursor.pBuffer && !x && !y && width &&
      height && width <= 256 && height <= 256) {
    const auto source = cursor.pBuffer->shm(), target = buffer->shm();
    if (source.success && target.success && source.format == target.format &&
        source.format == DRM_FORMAT_ARGB8888 &&
        source.size == Vector2D(int(width), int(height)) &&
        target.size == source.size && source.stride >= int(width * 4) &&
        target.stride >= int(width * 4)) {
      auto [src, srcFormat, srcLength] = cursor.pBuffer->beginDataPtr(0);
      auto [dst, dstFormat, dstLength] = buffer->beginDataPtr(0);
      // CCursorBuffer's third field is stride, whereas wl_shm buffers report
      // allocation length. Its owned vector is stride * height in 0.56.2.
      const bool sourceFits =
          dynamic_cast<Pointer::Cursor::CCursorBuffer *>(cursor.pBuffer.get())
              ? srcLength == size_t(source.stride)
              : srcLength >= size_t(source.stride) * height;
      const bool valid = src && dst && sourceFits &&
                         dstLength >= size_t(target.stride) * height;
      if (valid)
        for (uint32_t row = 0; row < height; row++)
          std::copy_n(src + size_t(row) * source.stride, width * 4,
                      dst + size_t(row) * target.stride);
      buffer->endDataPtr();
      cursor.pBuffer->endDataPtr();
      if (valid)
        return true;
    }
  }
  return reinterpret_cast<bool (*)(void *, CHLBufferReference, uint32_t,
                                   uint32_t, uint32_t, uint32_t)>(
      cursorReadHook->m_original)(fb, buffer, x, y, width, height);
}
static std::set<MONITORID> covered;
// Isolated native surface: Cindy surface/text/selection semantic palette,
// matching privacyScreenHtml. No desktop content is used to style the mask.
static bool dark = true;
static CHyprColor surface() {
  return CHyprColor(dark ? 0xFF1F1F1E : 0xFFF8F8F6);
}
static CHyprColor foreground() {
  return CHyprColor(dark ? 0xFFD4D4D4 : 0xFF262626);
}
static bool selectedDisconnect = false;
static std::vector<std::string> labels;
static std::vector<SP<ITexture>> texts;
static SP<ITexture> heroTexture, wordmarkTexture;
static SP<ITexture> artwork(const unsigned char *bytes, size_t size) {
  struct Reader { const unsigned char *data; size_t remaining; } reader{bytes, size};
  auto surface = cairo_image_surface_create_from_png_stream(
      [](void *context, unsigned char *out, unsigned int count) {
        auto &reader = *static_cast<Reader *>(context);
        if (count > reader.remaining)
          return CAIRO_STATUS_READ_ERROR;
        std::copy_n(reader.data, count, out);
        reader.data += count;
        reader.remaining -= count;
        return CAIRO_STATUS_SUCCESS;
      }, &reader);
  SP<ITexture> texture;
  if (cairo_surface_status(surface) == CAIRO_STATUS_SUCCESS) {
    texture = g_pHyprRenderer->createTexture(surface);
    if (texture)
      texture->m_imageDescription = NColorManagement::DEFAULT_SRGB_IMAGE_DESCRIPTION;
  }
  cairo_surface_destroy(surface);
  return texture;
}
static bool active() { return gate.phase != PrivacyGate::Off; }
static bool physicalOutput(PHLMONITOR monitor) {
  return monitor->m_output->getBackend()->type() !=
         Aquamarine::AQ_BACKEND_HEADLESS;
}
static void damage() {
  for (const auto &monitor : State::monitorState()->allMonitors()) {
    if (!monitor->enabled())
      continue;
    // Renderer::damageMonitor intentionally skips mirrored physical outputs.
    // Privacy must cover them too, including phone-fit headless/mirror layouts.
    monitor->addDamage(CBox{0, 0, INT16_MAX, INT16_MAX});
    monitor->scheduleFrame(Aquamarine::IOutput::AQ_SCHEDULE_DAMAGE);
  }
}
static void stop() {
  gate.stop();
  token.clear();
  covered.clear();
  selectedDisconnect = false;
  damage();
}
static bool consume(bool physical, unsigned key, bool down, bool trigger) {
  auto old = gate.phase;
  bool result = gate.consume(physical, key, down, trigger);
  if (old != gate.phase)
    damage();
  return result;
}
static void choose(bool disconnect) {
  gate.phase = disconnect ? PrivacyGate::Disconnect : PrivacyGate::Resume;
  damage();
}
static double dialogScale(PHLMONITOR monitor) {
  return std::min({static_cast<double>(monitor->m_scale),
                   monitor->m_transformedSize.x / 600.,
                   monitor->m_transformedSize.y / 300.});
}
static void clickDialog(PHLMONITOR monitor, Vector2D point) {
  if (gate.phase != PrivacyGate::Confirming)
    return;
  const auto scale = dialogScale(monitor);
  const auto p = point / scale;
  const double left = (monitor->m_transformedSize.x / scale - 560) / 2;
  const double top = (monitor->m_transformedSize.y / scale - 220) / 2;
  if (p.y >= top + 150 && p.y <= top + 202) {
    if (p.x >= left + 20 && p.x <= left + 270)
      choose(false);
    else if (p.x >= left + 280 && p.x <= left + 530)
      choose(true);
  }
}
static void keyboard(CInputManager *self, const IKeyboard::SKeyEvent &event,
                     SP<IKeyboard> keyboard) {
  bool physical = !keyboard->isVirtual();
  bool down = event.state == WL_KEYBOARD_KEY_STATE_PRESSED;
  bool dialog = gate.phase == PrivacyGate::Confirming && physical &&
                !gate.held.contains(event.keycode);
  if (consume(physical, event.keycode, down, down)) {
    if (dialog && down) {
      if (event.keycode == KEY_ESC)
        choose(false);
      else if (event.keycode == KEY_TAB || event.keycode == KEY_LEFT ||
               event.keycode == KEY_RIGHT) {
        selectedDisconnect = !selectedDisconnect;
        damage();
      } else if (event.keycode == KEY_ENTER)
        choose(selectedDisconnect);
    }
    return;
  }
  reinterpret_cast<void (*)(CInputManager *, const IKeyboard::SKeyEvent &,
                            SP<IKeyboard>)>(keyHook->m_original)(self, event,
                                                                 keyboard);
}
static void modifiers(CInputManager *self, SP<IKeyboard> keyboard) {
  if (active() &&
      (!keyboard->isVirtual() || (gate.phase != PrivacyGate::Active &&
                                  gate.phase != PrivacyGate::Pending)))
    return;
  reinterpret_cast<void (*)(CInputManager *, SP<IKeyboard>)>(
      modHook->m_original)(self, keyboard);
}
static uint32_t virtualModifiers(CInputManager *self) {
  uint32_t result = 0;
  for (const auto &keyboard : self->m_keyboards)
    if (keyboard->isVirtual() && keyboard->m_enabled && keyboard->shareStates())
      result |= keyboard->getModifiers();
  return result;
}
static uint32_t sharedModifiers(CInputManager *self, uint32_t depressed) {
  if (active())
    return depressed | virtualModifiers(self);
  return reinterpret_cast<uint32_t (*)(CInputManager *, uint32_t)>(
      sharedModsHook->m_original)(self, depressed);
}
static uint32_t allModifiers(CInputManager *self) {
  if (active())
    return virtualModifiers(self);
  return reinterpret_cast<uint32_t (*)(CInputManager *)>(
      allModsHook->m_original)(self);
}
static bool sharedKeys(CInputManager *self, uint32_t key, bool pressed) {
  if (active()) {
    if (pressed)
      return true;
    for (const auto &keyboard : self->m_keyboards)
      if (keyboard->isVirtual() && keyboard->m_enabled &&
          keyboard->shareStates() && keyboard->getPressed(key))
        return true;
    return false;
  }
  return reinterpret_cast<bool (*)(CInputManager *, uint32_t, bool)>(
      sharedKeysHook->m_original)(self, key, pressed);
}
static void button(CInputManager *self, IPointer::SButtonEvent event,
                   SP<IPointer> pointer) {
  bool physical = !pointer || !pointer->isVirtual();
  bool down = event.state == WL_POINTER_BUTTON_STATE_PRESSED;
  bool dialog = gate.phase == PrivacyGate::Confirming && physical &&
                !gate.held.contains(event.button + 1024);
  if (consume(physical, event.button + 1024, down, down)) {
    if (dialog && down && event.button == BTN_LEFT) {
      auto point = Pointer::mgr()->position();
      for (auto monitor : State::monitorState()->allMonitors()) {
        if (!monitor->enabled() || !physicalOutput(monitor))
          continue;
        auto source =
            monitor->m_mirrorOf ? monitor->m_mirrorOf.lock() : monitor;
        auto p = (point - source->m_position) * source->m_scale;
        if (p.x < 0 || p.y < 0 || p.x >= source->m_transformedSize.x ||
            p.y >= source->m_transformedSize.y)
          continue;
        if (source != monitor) {
          const auto scale = std::min(
              monitor->m_transformedSize.x / source->m_transformedSize.x,
              monitor->m_transformedSize.y / source->m_transformedSize.y);
          p = p * scale +
              (monitor->m_transformedSize - source->m_transformedSize * scale) /
                  2;
        }
        clickDialog(monitor, p);
      }
    }
    return;
  }
  reinterpret_cast<void (*)(CInputManager *, IPointer::SButtonEvent,
                            SP<IPointer>)>(buttonHook->m_original)(self, event,
                                                                   pointer);
}
static void axis(CInputManager *self, IPointer::SAxisEvent event,
                 SP<IPointer> pointer) {
  if (consume(!pointer || !pointer->isVirtual(), 2048, false, true))
    return;
  reinterpret_cast<void (*)(CInputManager *, IPointer::SAxisEvent,
                            SP<IPointer>)>(axisHook->m_original)(self, event,
                                                                 pointer);
}
static void motion(CInputManager *self, IPointer::SMotionEvent event) {
  if (active() && ((!event.device || !event.device->isVirtual())
                       ? gate.phase != PrivacyGate::Confirming
                       : gate.phase != PrivacyGate::Active))
    return;
  reinterpret_cast<void (*)(CInputManager *, IPointer::SMotionEvent)>(
      moveHook->m_original)(self, event);
}
static void warp(CInputManager *self, IPointer::SMotionAbsoluteEvent event) {
  auto pointer = dynamicPointerCast<IPointer>(event.device);
  if (active() && ((!pointer || !pointer->isVirtual())
                       ? gate.phase != PrivacyGate::Confirming
                       : gate.phase != PrivacyGate::Active))
    return;
  reinterpret_cast<void (*)(CInputManager *, IPointer::SMotionAbsoluteEvent)>(
      warpHook->m_original)(self, event);
}
static bool scanout(CMonitor *self) {
  return !active() &&
         reinterpret_cast<bool (*)(CMonitor *)>(scanoutHook->m_original)(self);
}
static bool needsCopy(CMonitor *self) {
  return active() || reinterpret_cast<bool (*)(CMonitor *)>(
                         needsCopyHook->m_original)(self);
}
// Save the unmasked image first, then mask the working framebuffer while the
// normal render context is still alive. Drawing after end() has invalidated
// framebuffer state is not safe on the physical DRM render path.
static bool copy(CHyprOpenGLImpl *self, const CBox &box) {
  const bool copied = reinterpret_cast<bool (*)(CHyprOpenGLImpl *, const CBox &)>(
      copyHook->m_original)(self, box);
  auto saved = g_pHyprRenderer->m_renderData;
  if (deferredCursorMonitor == saved.pMonitor) {
    // Paint only after the capture/mirror copy, preserving the local pointer.
    deferredCursor.render(saved.damage);
    deferredCursor.clear();
    deferredCursorMonitor.reset();
    g_pHyprRenderer->m_renderData = saved;
  }
  // Hyprland calls this only for non-fake output frames in end().
  if (!active() || !saved.pMonitor || !physicalOutput(saved.pMonitor.lock()))
    return copied;
  auto monitor = saved.pMonitor.lock();
  CBox full{0, 0, monitor->m_transformedSize.x, monitor->m_transformedSize.y};
  g_pHyprRenderer->m_renderData.damage = CRegion(full);
  g_pHyprRenderer->pushMonitorTransformEnabled(true);
  self->renderRect(full, surface(), {});
  self->blend(true);
  if (texts.empty()) {
    for (auto &label : labels) {
      auto texture = g_pHyprRenderer->renderText(label, foreground(), 18, false, "", 510);
      // Cairo text is sRGB. The final-copy renderer needs an explicit image
      // description, unlike the ordinary surface pass's implicit fallback.
      if (texture)
        texture->m_imageDescription = NColorManagement::DEFAULT_SRGB_IMAGE_DESCRIPTION;
      texts.push_back(texture);
    }
  }
  bool dialog = gate.phase == PrivacyGate::Confirming;
  const auto scale = dialogScale(monitor);
  double left = (full.w / scale - 560) / 2, top = (full.h / scale - 220) / 2;
  auto text = [&](size_t index, double x, double y, bool centered = false) {
    if (index >= texts.size() || !texts[index])
      return;
    auto size = texts[index]->m_size;
    if (centered)
      x -= size.x / 2;
    self->renderTexture(
        texts[index],
        CBox{x * scale, y * scale, size.x * scale, size.y * scale}, {});
  };
  if (!dialog) {
    if (!heroTexture)
      heroTexture = artwork(heroPng, sizeof(heroPng));
    if (!wordmarkTexture)
      wordmarkTexture = dark ? artwork(wordmarkDarkPng, sizeof(wordmarkDarkPng))
                             : artwork(wordmarkLightPng, sizeof(wordmarkLightPng));
    const double w = full.w / scale, h = full.h / scale;
    const bool portrait = w <= h;
    const double heroWidth = portrait ? std::min(w * .68, h * .46)
                                     : std::min({w * .48, h * .62, 600.});
    const double heroHeight = heroTexture ? heroWidth * heroTexture->m_size.y / heroTexture->m_size.x : heroWidth;
    const double gap = portrait ? 16. : std::clamp(w * .04, 24., 72.);
    const double copyWidth = std::min(460., portrait ? w * .85 : w * .92 - heroWidth - gap);
    const double markWidth = std::clamp(w * .18, 160., 230.);
    const double markHeight = wordmarkTexture ? markWidth * wordmarkTexture->m_size.y / wordmarkTexture->m_size.x : 60.;
    const double copyHeight = markHeight + 32 + 48 + 20 + 32;
    const double heroX = portrait ? (w - heroWidth) / 2 : (w - heroWidth - gap - copyWidth) / 2;
    const double heroY = portrait ? (h - heroHeight - gap - copyHeight) / 2 : (h - heroHeight) / 2;
    const double copyX = portrait ? (w - copyWidth) / 2 : heroX + heroWidth + gap;
    const double copyY = portrait ? heroY + heroHeight + gap : (h - copyHeight) / 2;
    if (heroTexture)
      self->renderTexture(heroTexture, CBox{heroX * scale, heroY * scale, heroWidth * scale, heroHeight * scale}, {});
    if (wordmarkTexture)
      self->renderTexture(wordmarkTexture, CBox{(portrait ? (w - markWidth) / 2 : copyX) * scale, copyY * scale, markWidth * scale, markHeight * scale}, {});
    text(0, portrait ? w / 2 : copyX, copyY + markHeight + 32, portrait);
    text(1, portrait ? w / 2 : copyX, copyY + markHeight + 100, portrait);
  } else {
    text(2, left + 24, top + 30);
    text(3, left + 24, top + 78);
  }
  if (dialog) {
    for (int i = 0; i < 2; i++) {
      double shade = selectedDisconnect == (i == 1) ? (dark ? .35 : .75)
                                                    : (dark ? .15 : .9);
      self->renderRect(CBox{(left + 20 + i * 260) * scale, (top + 150) * scale,
                            250 * scale, 52 * scale},
                       CHyprColor(shade, shade, shade, 1.), {});
      text(4 + i, left + 36 + i * 260, top + 164);
    }
  }
  g_pHyprRenderer->popMonitorTransformEnabled();
  g_pHyprRenderer->m_renderData = saved;
  covered.insert(monitor->m_id);
  return copied;
}
static void *symbol(const std::string &name) {
  auto qualified = name.substr(0, name.find('('));
  auto query = qualified.substr(qualified.rfind("::") + 2);
  auto matches = HyprlandAPI::findFunctionsByName(owner, query);
  std::erase_if(matches, [&](const auto &match) {
    return match.demangled.find(name) == std::string::npos;
  });
  if (matches.size() != 1)
    throw std::runtime_error("Unsupported compositor symbol: " + name + " (" +
                             std::to_string(matches.size()) + ")");
  return matches[0].address;
}
static CFunctionHook *hook(const std::string &name, void *replacement) {
  auto h = HyprlandAPI::createFunctionHook(owner, symbol(name), replacement);
  if (!h || !h->hook())
    throw std::runtime_error("Compositor hook unavailable");
  return h;
}
static std::string state() {
  if (gate.phase == PrivacyGate::Active)
    for (const auto &monitor : State::monitorState()->allMonitors())
      if (monitor->enabled() && physicalOutput(monitor) &&
          monitor->m_dpmsStatus && !covered.contains(monitor->m_id))
        return "starting";
  static const char *names[] = {"off",        "active", "pending",
                                "confirming", "resume", "disconnect"};
  return names[gate.phase];
}
static int tick(void *) {
  if (active() &&
      std::chrono::steady_clock::now() - heartbeat > std::chrono::seconds(6))
    stop();
  wl_event_source_timer_update(watchdog, 500);
  return 0;
}
APICALL EXPORT std::string PLUGIN_API_VERSION() { return HYPRLAND_API_VERSION; }
APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE handle) {
  owner = handle;
  retired = false;
  loading = true;
  if (std::string(__hyprland_api_get_hash()) !=
      __hyprland_api_get_client_hash())
    throw std::runtime_error("Hyprland ABI mismatch");
  copyHook = hook("CHyprOpenGLImpl::saveBufferForMirror", reinterpret_cast<void *>(copy));
  needsCopyHook = hook("CMonitor::needsACopyFB()", reinterpret_cast<void *>(needsCopy));
  softwareCursorHook = hook("CPointerManager::renderSoftwareCursorsFor(",
                            reinterpret_cast<void *>(softwareCursor));
  cursorRenderHook = hook("CCursorshareSession::render()",
                          reinterpret_cast<void *>(renderCursor));
  cursorClearHook =
      hook("IHyprRenderer::draw(CClearPassElement::SClearData const&",
           reinterpret_cast<void *>(clearCursor));
  cursorReadHook =
      hook("CGLFramebuffer::readPixels(", reinterpret_cast<void *>(readCursor));
  sendCursorEvents = reinterpret_cast<void (*)(void *)>(
      symbol("CImageCopyCaptureCursorSession::sendCursorEvents()"));
  cursorConstraintsHook =
      hook("CImageCopyCaptureCursorSession::sendConstraints()",
           reinterpret_cast<void *>(cursorConstraints));
  keyHook =
      hook("CInputManager::onKeyboardKey", reinterpret_cast<void *>(keyboard));
  modHook =
      hook("CInputManager::onKeyboardMod", reinterpret_cast<void *>(modifiers));
  sharedModsHook = hook("CInputManager::shareModsFromAllKBs",
                        reinterpret_cast<void *>(sharedModifiers));
  allModsHook = hook("CInputManager::getModsFromAllKBs",
                     reinterpret_cast<void *>(allModifiers));
  sharedKeysHook = hook("CInputManager::shareKeyFromAllKBs",
                        reinterpret_cast<void *>(sharedKeys));
  buttonHook =
      hook("CInputManager::onMouseButton", reinterpret_cast<void *>(button));
  axisHook =
      hook("CInputManager::onMouseWheel", reinterpret_cast<void *>(axis));
  moveHook =
      hook("CInputManager::onMouseMoved", reinterpret_cast<void *>(motion));
  warpHook = hook("CInputManager::onMouseWarp", reinterpret_cast<void *>(warp));
  scanoutHook =
      hook("CMonitor::attemptDirectScanout", reinterpret_cast<void *>(scanout));
  listeners.push_back(
      Event::bus()->m_events.config.reloaded.listen([] { loading = false; }));
  listeners.push_back(
      Event::bus()->m_events.render.stage.listen([](eRenderStage stage) {
        if (stage == RENDER_POST_MIRROR)
          mirroredCursor();
        if (active() && stage == RENDER_PRE)
          for (const auto &monitor : State::monitorState()->allMonitors())
            if (monitor->enabled())
              // The working image was masked last frame. Repaint it fully
              // before saving the next unmasked capture; do not schedule an
              // extra frame here or turn idle privacy into a render loop.
              monitor->addDamage(CBox{0, 0, INT16_MAX, INT16_MAX});
      }));
  auto block = [](auto event, Event::SCallbackInfo &info) {
    if (active()) {
      consume(true, 4096, false, true);
      info.cancelled = true;
    }
  };
  listeners.push_back(Event::bus()->m_events.input.touch.down.listen(
      [](ITouch::SDownEvent event, Event::SCallbackInfo &info) {
        if (!active())
          return;
        info.cancelled = true;
        if (!event.device || event.device->isVirtual())
          return;
        if (gate.phase == PrivacyGate::Confirming) {
          for (const auto &monitor : State::monitorState()->allMonitors())
            if (monitor->m_name == event.device->m_boundOutput)
              clickDialog(monitor, event.pos * monitor->m_transformedSize);
        } else
          consume(true, 4096, false, true);
      }));
  listeners.push_back(Event::bus()->m_events.input.touch.up.listen(block));
  listeners.push_back(Event::bus()->m_events.input.touch.motion.listen(block));
  listeners.push_back(Event::bus()->m_events.input.tablet.axis.listen(block));
  listeners.push_back(Event::bus()->m_events.input.tablet.button.listen(block));
  listeners.push_back(Event::bus()->m_events.input.tablet.tip.listen(block));
  listeners.push_back(Event::bus()->m_events.gesture.swipe.begin.listen(block));
  listeners.push_back(
      Event::bus()->m_events.gesture.swipe.update.listen(block));
  listeners.push_back(Event::bus()->m_events.gesture.swipe.end.listen(block));
  listeners.push_back(Event::bus()->m_events.gesture.pinch.begin.listen(block));
  listeners.push_back(
      Event::bus()->m_events.gesture.pinch.update.listen(block));
  listeners.push_back(Event::bus()->m_events.gesture.pinch.end.listen(block));
  watchdog = wl_event_loop_add_timer(
      wl_display_get_event_loop(g_pCompositor->m_wlDisplay), tick, nullptr);
  if (!watchdog)
    throw std::runtime_error("Compositor timer unavailable");
  wl_event_source_timer_update(watchdog, 500);
  command = HyprlandAPI::registerHyprCtlCommand(
      owner,
      {"cindy-privacy", false, [](eHyprCtlOutputFormat, std::string request) {
         try {
           if (request.size() > 8192)
             throw std::runtime_error("size");
           auto body = request.substr(request.find(' ') + 1);
           auto parser = json_tokener_new();
           json_tokener_set_flags(parser, JSON_TOKENER_STRICT |
                                              JSON_TOKENER_VALIDATE_UTF8);
           auto raw = json_tokener_parse_ex(parser, body.c_str(), body.size());
           auto parsed =
               json_tokener_get_error(parser) == json_tokener_success &&
               json_tokener_get_parse_end(parser) == body.size();
           json_tokener_free(parser);
           std::unique_ptr<json_object, decltype(&json_object_put)> value(
               raw, json_object_put);
           if (!parsed || !raw || !json_object_is_type(raw, json_type_object))
             throw std::runtime_error("json");
           auto op = stringValue(json_object_object_get(raw, "op"));
           if (op == "probe")
             return std::string(loading ? "loading:" : "ready:") +
                    CINDY_PRIVACY_SOURCE;
           if (op == "retire") {
             if (active())
               throw std::runtime_error("owned");
             Dl_info library{};
             if (!dladdr(reinterpret_cast<void *>(state), &library) ||
                 !library.dli_fname)
               throw std::runtime_error("library");
             retired = true;
             return std::string(library.dli_fname);
           }
           if (retired || loading)
             throw std::runtime_error("retired");
           auto key = stringValue(json_object_object_get(raw, "token"));
           if (key.size() != 32 ||
               key.find_first_not_of("0123456789abcdef") != std::string::npos)
             throw std::runtime_error("token");
           if (op == "start" && !active()) {
             auto items = json_object_object_get(raw, "labels");
             if (!items || !json_object_is_type(items, json_type_array) ||
                 json_object_array_length(items) != 6)
               throw std::runtime_error("labels");
             std::vector<std::string> next;
             for (size_t i = 0; i < 6; i++)
               next.push_back(stringValue(json_object_array_get_idx(items, i)));
             for (auto &label : next)
               if (label.size() > 1024)
                 throw std::runtime_error("label");
             auto theme = json_object_object_get(raw, "dark");
             if (!theme || !json_object_is_type(theme, json_type_boolean))
               throw std::runtime_error("theme");
             dark = json_object_get_boolean(theme);
             wordmarkTexture.reset();
             token = key;
             labels = next;
             texts.clear();
             covered.clear();
             gate.phase = PrivacyGate::Active;
             damage();
           }
           if (key != token)
             throw std::runtime_error("owner");
           heartbeat = std::chrono::steady_clock::now();
           if (op == "stop")
             stop();
           else if (op == "confirm" && gate.phase == PrivacyGate::Pending) {
             gate.phase = PrivacyGate::Confirming;
             selectedDisconnect = false;
             damage();
           } else if (op == "resume" && gate.phase == PrivacyGate::Resume) {
             gate.phase = PrivacyGate::Active;
             damage();
           } else if (op != "start" && op != "ping")
             throw std::runtime_error("operation");
           return state();
         } catch (...) {
           return std::string("unavailable");
         }
       }});
  return {"cindy-privacy", "Lease-scoped physical privacy, capture preserved",
          "Cindy", "1"};
}
APICALL EXPORT void PLUGIN_EXIT() {
  stop();
  listeners.clear();
  texts.clear();
  heroTexture.reset();
  wordmarkTexture.reset();
  deferredCursor.clear();
  deferredCursorMonitor.reset();
  if (watchdog)
    wl_event_source_remove(watchdog);
  watchdog = nullptr;
}
