#include "freerdp_adapter.h"

#include "unicode.h"
#include "frame_protocol.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <future>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <thread>
#include <utility>

#if !defined(OFS_RDP_HAS_FREERDP)
#define OFS_RDP_HAS_FREERDP 0
#endif

#if OFS_RDP_HAS_FREERDP
#include <freerdp/addin.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/channels/disp.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/disp.h>
#include <freerdp/event.h>
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <winpr/crt.h>
#endif

struct FreeRdpAdapter::Impl {
  Config config;
  StateCallback state;
  PromptCallback prompt;
  FrameCallback frame;
  ClipboardCallback clipboard;

#if OFS_RDP_HAS_FREERDP
  enum class CommandKind {
    password,
    certificate,
    resize,
    key,
    pointer,
    clipboardSet,
    clipboardGet,
    stop
  };

  struct Command {
    CommandKind kind = CommandKind::stop;
    std::shared_ptr<std::promise<bool>> completion;
    std::string text;
    Display display;
    std::uint32_t requestId = 0;
    std::uint32_t scanCode = 0;
    std::optional<std::uint32_t> unicode;
    std::uint32_t x = 0;
    std::uint32_t y = 0;
    std::uint32_t buttons = 0;
    std::int32_t wheelX = 0;
    std::int32_t wheelY = 0;
    bool value = false;
    bool extended = false;
  };

  std::mutex commandMutex;
  std::condition_variable commandCv;
  std::deque<Command> commands;
  std::thread eventThread;
  bool running = false;
  std::atomic_bool stopping{false};

  // These fields are owned exclusively by eventThread. FreeRDP callbacks run
  // on that thread too; the stdin thread only enqueues Command values.
  freerdp* instance = nullptr;
  CliprdrClientContext* cliprdr = nullptr;
  DispClientContext* disp = nullptr;
  bool connected = false;
  bool displayControlReady = false;
  std::uint64_t maximumMonitorArea = 0;
  bool certificateRejected = false;
  std::uint32_t nextSequence = 0;
  std::uint32_t nextCertificateRequest = 1;
  std::uint32_t pendingCertificateRequest = 0;
  std::string clipboardText;
  std::deque<std::uint32_t> pendingClipboardRequests;
  std::uint32_t lastButtons = 0;
  static inline Impl* active = nullptr;

  static constexpr std::uint32_t kMaxFramePayload = ofs::rdp::frame::kMaxPayload;
  static constexpr std::uint32_t kFrameHeaderSize = ofs::rdp::frame::kFrameHeaderSize;
  static constexpr std::uint32_t kRectHeaderSize = ofs::rdp::frame::kRectHeaderSize;
  static constexpr std::uint32_t kMaxFrameRects = ofs::rdp::frame::kMaxFrameRects;

  static Impl* self(freerdp* value) {
    return active && value == active->instance ? active : nullptr;
  }

  static BOOL preConnect(freerdp* value) {
    Impl* self = Impl::self(value);
    if (!self) return FALSE;
    if (PubSub_SubscribeChannelConnected(value->context->pubSub, channelConnected) < 0 ||
        PubSub_SubscribeChannelDisconnected(value->context->pubSub, channelDisconnected) < 0)
      return FALSE;
    // This loader registers cliprdr as a static channel and disp through
    // drdynvc according to the settings frozen during initialize().
    if (!freerdp_client_load_addins(value->context->channels, value->context->settings)) {
      self->emitState("failed", "UNSUPPORTED");
      return FALSE;
    }
    return TRUE;
  }

  static void channelConnected(void* context, const ChannelConnectedEventArgs* event) {
    Impl* self = active;
    if (self && self->instance && self->instance->context != context) self = nullptr;
    if (!self || !event || !event->name) return;
    if (std::strcmp(event->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) {
      self->cliprdr = static_cast<CliprdrClientContext*>(event->pInterface);
      if (!self->cliprdr) return;
      self->cliprdr->custom = self;
      self->cliprdr->ServerFormatList = serverFormatList;
      self->cliprdr->ServerFormatDataRequest = serverFormatDataRequest;
      self->cliprdr->ServerFormatDataResponse = serverFormatDataResponse;
    } else if (std::strcmp(event->name, DISP_DVC_CHANNEL_NAME) == 0) {
      self->disp = static_cast<DispClientContext*>(event->pInterface);
      if (self->disp) {
        self->disp->custom = self;
        self->disp->DisplayControlCaps = displayControlCaps;
      }
    }
  }

  static void channelDisconnected(void* context, const ChannelDisconnectedEventArgs* event) {
    Impl* self = active;
    if (self && self->instance && self->instance->context != context) self = nullptr;
    if (!self || !event || !event->name) return;
    if (std::strcmp(event->name, CLIPRDR_SVC_CHANNEL_NAME) == 0) self->cliprdr = nullptr;
    else if (std::strcmp(event->name, DISP_DVC_CHANNEL_NAME) == 0) {
      self->disp = nullptr;
      self->displayControlReady = false;
      self->maximumMonitorArea = 0;
    }
  }

  static UINT displayControlCaps(DispClientContext* context, UINT32 maxNumMonitors,
                                 UINT32 maxMonitorAreaFactorA,
                                 UINT32 maxMonitorAreaFactorB) {
    Impl* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (!self || maxNumMonitors == 0) return 1;
    self->maximumMonitorArea = static_cast<std::uint64_t>(maxMonitorAreaFactorA) *
                               maxMonitorAreaFactorB;
    self->displayControlReady = true;
    return 0;
  }

  static UINT serverFormatList(CliprdrClientContext* context,
                               const CLIPRDR_FORMAT_LIST* formatList) {
    (void)formatList;
    return context && context->custom ? 0 : 1;
  }

  static UINT serverFormatDataRequest(CliprdrClientContext* context,
                                      const CLIPRDR_FORMAT_DATA_REQUEST* request) {
    Impl* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (!self || !request || request->requestedFormatId != 13 ||
        !context->ClientFormatDataResponse)
      return 1;
    std::vector<std::uint8_t> utf16;
    if (!ofs::rdp::utf8ToUtf16Le(self->clipboardText, utf16)) return 1;
    CLIPRDR_FORMAT_DATA_RESPONSE response{};
    response.common.msgType = CB_FORMAT_DATA_RESPONSE;
    response.common.msgFlags = CB_RESPONSE_OK;
    response.common.dataLen = static_cast<UINT32>(utf16.size());
    response.requestedFormatData = utf16.data();
    return context->ClientFormatDataResponse(context, &response);
  }

  static UINT serverFormatDataResponse(CliprdrClientContext* context,
                                       const CLIPRDR_FORMAT_DATA_RESPONSE* response) {
    Impl* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (!self || !response || !response->requestedFormatData ||
        response->common.dataLen > 4u * 1024u * 1024u)
      return 1;
    std::uint32_t requestId = 0;
    if (!self->pendingClipboardRequests.empty()) {
      requestId = self->pendingClipboardRequests.front();
      self->pendingClipboardRequests.pop_front();
    }
    std::string text;
    if (!ofs::rdp::utf16LeToUtf8(response->requestedFormatData,
                                 response->common.dataLen, text))
      return 1;
    if (requestId != 0 && self->clipboard) self->clipboard(requestId, std::move(text));
    return 0;
  }

  static BOOL postConnect(freerdp* value) {
    Impl* self = Impl::self(value);
    if (!self || !value->context || !value->context->update ||
        !gdi_init(value, PIXEL_FORMAT_BGRA32))
      return FALSE;
    value->context->update->BeginPaint = beginPaint;
    value->context->update->EndPaint = endPaint;
    value->context->update->DesktopResize = desktopResize;
    return TRUE;
  }

  static BOOL beginPaint(rdpContext* context) {
    return context && active && active->instance && active->instance->context == context;
  }

  static BOOL endPaint(rdpContext* context) {
    Impl* self = active;
    if (self && self->instance && self->instance->context != context) self = nullptr;
    if (!self || !context || !context->gdi) return FALSE;
    rdpGdi* gdi = context->gdi;
    if (!gdi->primary_buffer || !gdi->primary || !gdi->primary->bitmap ||
        !gdi->primary->hdc || !gdi->primary->hdc->hwnd || gdi->width <= 0 ||
        gdi->height <= 0 || gdi->stride <= 0)
      return FALSE;
    const auto width = static_cast<std::uint32_t>(gdi->width);
    const auto height = static_cast<std::uint32_t>(gdi->height);
    const auto stride = static_cast<std::uint32_t>(gdi->stride);
    const auto bitmapStride = static_cast<std::uint32_t>(gdi->primary->bitmap->scanline);
    const std::uint64_t framebufferBytes = static_cast<std::uint64_t>(stride) * height;
    if (!ofs::rdp::frame::validCanvas(width, height) ||
        static_cast<std::uint64_t>(width) * 4u > stride ||
        bitmapStride != stride || bitmapStride < static_cast<std::uint64_t>(width) * 4u ||
        gdi->primary->bitmap->data != gdi->primary_buffer ||
        framebufferBytes > std::numeric_limits<std::uint32_t>::max() ||
        framebufferBytes > static_cast<std::uint64_t>(bitmapStride) * height)
      return FALSE;

    const HGDI_WND window = gdi->primary->hdc->hwnd;
    if (window->ninvalid <= 0 || !window->cinvalid) return TRUE;

    std::vector<Rect> batch;
    std::uint64_t batchBytes = kFrameHeaderSize;
    try {
      for (INT32 index = 0; index < window->ninvalid; ++index) {
        const GDI_RGN& dirty = window->cinvalid[index];
        if (dirty.w <= 0 || dirty.h <= 0) continue;

        const std::int64_t left = std::max<std::int64_t>(0, dirty.x);
        const std::int64_t top = std::max<std::int64_t>(0, dirty.y);
        const std::int64_t right = std::min<std::int64_t>(width,
            static_cast<std::int64_t>(dirty.x) + dirty.w);
        const std::int64_t bottom = std::min<std::int64_t>(height,
            static_cast<std::int64_t>(dirty.y) + dirty.h);
        if (left >= right || top >= bottom) continue;

        const auto rectX = static_cast<std::uint32_t>(left);
        const auto rectY = static_cast<std::uint32_t>(top);
        const auto rectWidth = static_cast<std::uint32_t>(right - left);
        const auto rectHeight = static_cast<std::uint32_t>(bottom - top);
        const std::uint64_t rowBytes = static_cast<std::uint64_t>(rectWidth) * 4u;
        if (rowBytes == 0 || rowBytes > std::numeric_limits<std::uint32_t>::max()) return FALSE;

        // Split large invalidations into compact rows so one update never
        // forces an over-limit OFSR frame or copies untouched columns.
        const std::uint64_t maxRows =
            (kMaxFramePayload - kFrameHeaderSize - kRectHeaderSize) / rowBytes;
        if (maxRows == 0) return FALSE;
        std::uint32_t copiedRows = 0;
        while (copiedRows < rectHeight) {
          const auto sliceHeight = static_cast<std::uint32_t>(std::min<std::uint64_t>(
              rectHeight - copiedRows, maxRows));
          const std::uint64_t sliceBytes = rowBytes * sliceHeight;
          const std::uint64_t sourceOffset =
              (static_cast<std::uint64_t>(rectY) + copiedRows) * stride +
              static_cast<std::uint64_t>(rectX) * 4u;
          const std::uint64_t sourceLastByte =
              sourceOffset + (static_cast<std::uint64_t>(sliceHeight) - 1u) * stride + rowBytes;
          if (sourceOffset > framebufferBytes || sourceLastByte > framebufferBytes)
            return FALSE;

          if (batch.size() == kMaxFrameRects ||
              batchBytes > kMaxFramePayload - kRectHeaderSize - sliceBytes) {
            if (!self->emitFrame(width, height, std::move(batch))) return FALSE;
            batch = {};
            batchBytes = kFrameHeaderSize;
          }

          Rect rect;
          rect.x = static_cast<std::int32_t>(rectX);
          rect.y = static_cast<std::int32_t>(rectY + copiedRows);
          rect.width = rectWidth;
          rect.height = sliceHeight;
          rect.stride = static_cast<std::uint32_t>(rowBytes);
          rect.pixels.resize(static_cast<std::size_t>(sliceBytes));
          for (std::uint32_t row = 0; row < sliceHeight; ++row) {
            const auto* source = gdi->primary_buffer +
                (static_cast<std::uint64_t>(rect.y) + row) * stride +
                static_cast<std::uint64_t>(rect.x) * 4u;
            std::memcpy(rect.pixels.data() + static_cast<std::size_t>(row) * rowBytes,
                        source, static_cast<std::size_t>(rowBytes));
          }
          batchBytes += kRectHeaderSize + sliceBytes;
          batch.emplace_back(std::move(rect));
          copiedRows += sliceHeight;
        }
      }
      if (!batch.empty() && !self->emitFrame(width, height, std::move(batch))) return FALSE;
    } catch (const std::bad_alloc&) {
      return FALSE;
    }
    return TRUE;
  }

  static BOOL desktopResize(rdpContext* context) {
    if (!context || !context->gdi || !context->settings) return FALSE;
    const UINT32 width = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    const UINT32 height = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    return gdi_resize(context->gdi, width, height);
  }

  static DWORD verifyCertificateEx(freerdp* value, const char* host, UINT16 port,
                                   const char* commonName, const char* subject,
                                   const char* issuer, const char* fingerprint, DWORD flags) {
    return verifyCertificateInternal(value, host, port, commonName, subject, issuer,
                                     fingerprint, (flags & VERIFY_CERT_FLAG_CHANGED) != 0)
               ? 2u
               : 0u;
  }

  static DWORD verifyChangedCertificateEx(freerdp* value, const char* host, UINT16 port,
                                          const char* commonName, const char* subject,
                                          const char* issuer, const char* fingerprint,
                                          const char* oldSubject, const char* oldIssuer,
                                          const char* oldFingerprint, DWORD flags) {
    (void)oldSubject;
    (void)oldIssuer;
    (void)oldFingerprint;
    (void)flags;
    return verifyCertificateInternal(value, host, port, commonName, subject, issuer,
                                     fingerprint, true)
               ? 2u
               : 0u;
  }

  static bool verifyCertificateInternal(freerdp* value, const char* hostName,
                                        UINT16 hostPort, const char* commonName,
                                        const char* subject, const char* issuer,
                                        const char* fingerprint, bool changed) {
    Impl* self = Impl::self(value);
    if (!self) return false;
    if (self->config.certificatePolicy == "strict") {
      self->certificateRejected = true;
      return false;
    }
    std::uint32_t requestId = self->nextCertificateRequest++;
    if (requestId == 0) requestId = self->nextCertificateRequest++;
    self->pendingCertificateRequest = requestId;
    const std::string host = hostName ? hostName : (commonName ? commonName : self->config.host);
    const std::string subjectValue = subject ? subject : "";
    const std::string issuerValue = issuer ? issuer : "";
    const std::string fingerprintValue = fingerprint ? fingerprint : "";
    if (self->prompt) {
      self->prompt(requestId, host.c_str(), hostPort != 0 ? hostPort : self->config.port,
                   subjectValue.c_str(), issuerValue.c_str(), fingerprintValue.c_str(), changed);
    }
    const bool accepted = self->waitForCertificateDecision(requestId);
    self->pendingCertificateRequest = 0;
    if (!accepted) self->certificateRejected = true;
    return accepted;
  }

  bool waitForCertificateDecision(std::uint32_t requestId) {
    std::unique_lock<std::mutex> lock(commandMutex);
    while (!stopping.load()) {
      commandCv.wait(lock, [&] {
        return stopping.load() || std::any_of(commands.begin(), commands.end(), [&](const Command& command) {
          return command.kind == CommandKind::stop ||
                 (command.kind == CommandKind::certificate && command.requestId == requestId);
        });
      });
      auto found = std::find_if(commands.begin(), commands.end(), [&](const Command& command) {
        return command.kind == CommandKind::stop ||
               (command.kind == CommandKind::certificate && command.requestId == requestId);
      });
      if (found == commands.end()) continue;
      Command command = std::move(*found);
      commands.erase(found);
      if (command.kind == CommandKind::stop) {
        stopping.store(true);
        command.completion->set_value(true);
        return false;
      }
      const bool accepted = command.value;
      command.completion->set_value(true);
      return accepted;
    }
    return false;
  }

  void emitState(const char* value, const char* errorCode = nullptr) {
    if (state) state(value, errorCode);
  }

  static bool sendUnicodeScalar(rdpInput* input, std::uint32_t value, bool pressed) {
    if (!input || !ofs::rdp::isUnicodeScalar(value)) return false;
    const UINT16 flags = pressed ? 0 : KBD_FLAGS_RELEASE;
    const auto sendUnit = [&](UINT16 unit) {
      return freerdp_input_send_unicode_keyboard_event(input, flags, unit) != FALSE;
    };
    if (value <= 0xffffu) return sendUnit(static_cast<UINT16>(value));
    const std::uint32_t scalar = value - 0x10000u;
    return sendUnit(static_cast<UINT16>(0xd800u + (scalar >> 10))) &&
           sendUnit(static_cast<UINT16>(0xdc00u + (scalar & 0x3ffu)));
  }

  bool emitFrame(std::uint32_t width, std::uint32_t height, std::vector<Rect> rects) {
    if (!frame || rects.empty() || rects.size() > kMaxFrameRects ||
        !ofs::rdp::frame::validCanvas(width, height))
      return false;
    std::uint64_t payloadBytes = kFrameHeaderSize;
    for (const auto& rect : rects) {
      if (!ofs::rdp::frame::validRect(width, height, rect.x, rect.y, rect.width,
                                      rect.height, rect.stride, rect.pixels.size(),
                                      payloadBytes))
        return false;
      payloadBytes += kRectHeaderSize + rect.pixels.size();
    }
    frame(width, height, ++nextSequence, std::move(rects));
    return true;
  }

  bool initialize() {
    instance = freerdp_new();
    if (!instance || !freerdp_context_new(instance)) return false;
    // freerdp_context_new() creates the core context but does not install the
    // client channel provider. Without it, the static cliprdr and disp
    // add-ins cannot be resolved by freerdp_client_load_addins().
    if (freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0) != 0)
      return false;
    active = this;
    instance->PreConnect = preConnect;
    instance->PostConnect = postConnect;
    instance->VerifyCertificateEx = verifyCertificateEx;
    instance->VerifyChangedCertificateEx = verifyChangedCertificateEx;
    rdpSettings* settings = instance->context->settings;
    return settings &&
           freerdp_settings_set_string(settings, FreeRDP_ServerHostname, config.host.c_str()) &&
           freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, config.port) &&
           freerdp_settings_set_string(settings, FreeRDP_Username, config.username.c_str()) &&
           freerdp_settings_set_string(settings, FreeRDP_Domain, config.domain.c_str()) &&
           freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, config.display.width) &&
           freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, config.display.height) &&
           freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32) &&
           freerdp_settings_set_bool(settings, FreeRDP_DesktopResize, TRUE) &&
           freerdp_settings_set_bool(settings, FreeRDP_SupportDisplayControl, TRUE) &&
           freerdp_settings_set_bool(settings, FreeRDP_DynamicResolutionUpdate, TRUE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard,
                                     config.clipboard ? TRUE : FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_DeviceRedirection, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectDrives, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectSmartCards, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectPrinters, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectSerialPorts, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectParallelPorts, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_AudioCapture, FALSE) &&
           // FreeRDP's client loader promotes these defaults to rdpdr when
           // network autodetect, heartbeat, or multitransport is enabled.
           // The embedded worker intentionally ships no device-redirection
           // channel, so keep those optional features off as well.
           freerdp_settings_set_bool(settings, FreeRDP_NetworkAutoDetect, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_SupportHeartbeatPdu, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_SupportMultitransport, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_UnicodeInput, TRUE) &&
           freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity, TRUE) &&
           freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, TRUE);
  }

  bool waitForPassword() {
    std::unique_lock<std::mutex> lock(commandMutex);
    while (!stopping.load()) {
      commandCv.wait(lock, [&] { return stopping.load() || !commands.empty(); });
      if (stopping.load()) return false;
      Command command = std::move(commands.front());
      commands.pop_front();
      lock.unlock();
      bool result = false;
      if (command.kind == CommandKind::password && instance && instance->context) {
        result = freerdp_settings_set_string(instance->context->settings, FreeRDP_Password,
                                             command.text.c_str());
        std::fill(command.text.begin(), command.text.end(), '\0');
      } else if (command.kind == CommandKind::stop) {
        result = true;
        stopping.store(true);
      }
      command.completion->set_value(result);
      if (command.kind == CommandKind::password) return result;
      if (command.kind == CommandKind::stop) return false;
      lock.lock();
    }
    return false;
  }

  bool sendMonitorLayout(Display next) {
    if (!connected || !instance || !instance->context || !waitForChannel([&] {
          return disp && disp->SendMonitorLayout && displayControlReady;
        }))
      return false;
    if (maximumMonitorArea != 0 &&
        static_cast<std::uint64_t>(next.width) * next.height > maximumMonitorArea)
      return false;
    const std::uint32_t dpi = std::max<std::uint32_t>(next.dpi, 96u);
    DISPLAY_CONTROL_MONITOR_LAYOUT layout{};
    layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
    layout.Width = next.width;
    layout.Height = next.height;
    layout.PhysicalWidth = std::clamp<std::uint32_t>((next.width * 254u) / (dpi * 10u), 10u, 10000u);
    layout.PhysicalHeight = std::clamp<std::uint32_t>((next.height * 254u) / (dpi * 10u), 10u, 10000u);
    layout.Orientation = ORIENTATION_LANDSCAPE;
    layout.DesktopScaleFactor = std::clamp<std::uint32_t>((dpi * 100u) / 96u, 100u, 500u);
    layout.DeviceScaleFactor = 100;
    const bool sent = disp->SendMonitorLayout(disp, 1, &layout) == 0;
    if (!sent) return false;
    rdpSettings* settings = instance->context->settings;
    if (!freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, next.width) ||
        !freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, next.height))
      return false;
    config.display = next;
    return true;
  }

  template <typename Predicate>
  bool waitForChannel(Predicate ready) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (!ready()) {
      if (stopping.load() || std::chrono::steady_clock::now() >= deadline) return false;
      {
        std::lock_guard<std::mutex> lock(commandMutex);
        if (std::any_of(commands.begin(), commands.end(), [](const Command& command) {
              return command.kind == CommandKind::stop;
            }))
          return false;
      }
      if (!freerdp_check_fds(instance)) return false;
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return true;
  }

  bool execute(Command& command) {
    if (command.kind == CommandKind::stop) {
      stopping.store(true);
      return true;
    }
    if (!connected || !instance || !instance->context) return false;
    switch (command.kind) {
      case CommandKind::resize:
        return sendMonitorLayout(command.display);
      case CommandKind::key: {
        if (command.scanCode == 0 || command.scanCode > 0xff) return false;
        if (!instance->context->input) return false;
        // Text-bearing events use FreeRDP's Unicode path. Physical keyups
        // remain scan-code events when the renderer omits the scalar, which
        // preserves modifier and extended-key behavior.
        if (command.unicode.has_value() &&
            freerdp_settings_get_bool(instance->context->settings, FreeRDP_UnicodeInput)) {
          const std::uint32_t value = *command.unicode;
          if (!ofs::rdp::isUnicodeScalar(value)) return false;
          return sendUnicodeScalar(instance->context->input, value, command.value);
        }
        UINT16 flags = command.extended ? KBD_FLAGS_EXTENDED : 0;
        if (!command.value) flags |= KBD_FLAGS_RELEASE;
        return freerdp_input_send_keyboard_event(instance->context->input, flags,
                                                 static_cast<UINT16>(command.scanCode));
      }
      case CommandKind::pointer: {
        const UINT16 px = static_cast<UINT16>(std::min<std::uint32_t>(command.x, 0xffffu));
        const UINT16 py = static_cast<UINT16>(std::min<std::uint32_t>(command.y, 0xffffu));
        bool ok = freerdp_input_send_mouse_event(instance->context->input, PTR_FLAGS_MOVE, px, py);
        const std::uint32_t normalized = command.buttons & 0x7u;
        const std::uint32_t changed = lastButtons ^ normalized;
        const struct ButtonFlag { std::uint32_t mask; UINT16 flag; } buttonFlags[] = {
            {1u, PTR_FLAGS_BUTTON1}, {2u, PTR_FLAGS_BUTTON2}, {4u, PTR_FLAGS_BUTTON3}};
        for (const auto& button : buttonFlags) {
          if ((changed & button.mask) == 0) continue;
          UINT16 flags = button.flag;
          if ((normalized & button.mask) != 0) flags |= PTR_FLAGS_DOWN;
          ok = freerdp_input_send_mouse_event(instance->context->input, flags, px, py) && ok;
        }
        lastButtons = normalized;
        const auto wheelMagnitude = [](std::int32_t value) {
          const auto wide = static_cast<std::int64_t>(value);
          return static_cast<UINT16>(std::min<std::int64_t>(std::llabs(wide), 0x7f));
        };
        if (command.wheelY != 0) {
          UINT16 flags = PTR_FLAGS_WHEEL | wheelMagnitude(command.wheelY);
          if (command.wheelY < 0) flags |= PTR_FLAGS_WHEEL_NEGATIVE;
          ok = freerdp_input_send_mouse_event(instance->context->input, flags, px, py) && ok;
        }
        if (command.wheelX != 0) {
          UINT16 flags = PTR_FLAGS_HWHEEL | wheelMagnitude(command.wheelX);
          if (command.wheelX < 0) flags |= PTR_FLAGS_WHEEL_NEGATIVE;
          ok = freerdp_input_send_mouse_event(instance->context->input, flags, px, py) && ok;
        }
        return ok;
      }
      case CommandKind::clipboardSet: {
        if (!config.clipboard || !waitForChannel([&] {
              return cliprdr && cliprdr->ClientFormatList;
            }))
          return false;
        std::vector<std::uint8_t> validated;
        if (!ofs::rdp::utf8ToUtf16Le(command.text, validated)) return false;
        clipboardText = command.text;
        CLIPRDR_FORMAT format{};
        format.formatId = 13;
        CLIPRDR_FORMAT_LIST list{};
        list.common.msgType = CB_FORMAT_LIST;
        list.numFormats = 1;
        list.formats = &format;
        return cliprdr->ClientFormatList(cliprdr, &list) == 0;
      }
      case CommandKind::clipboardGet: {
        if (!config.clipboard || command.requestId == 0 || !waitForChannel([&] {
              return cliprdr && cliprdr->ClientFormatDataRequest;
            }))
          return false;
        pendingClipboardRequests.push_back(command.requestId);
        CLIPRDR_FORMAT_DATA_REQUEST request{};
        request.common.msgType = CB_FORMAT_DATA_REQUEST;
        request.common.dataLen = sizeof(request.requestedFormatId);
        request.requestedFormatId = 13;
        const bool sent = cliprdr->ClientFormatDataRequest(cliprdr, &request) == 0;
        if (!sent) pendingClipboardRequests.pop_back();
        return sent;
      }
      case CommandKind::password:
      case CommandKind::certificate:
      case CommandKind::stop:
        return false;
    }
    return false;
  }

  void processCommands() {
    while (true) {
      Command command;
      {
        std::lock_guard<std::mutex> lock(commandMutex);
        if (commands.empty()) return;
        command = std::move(commands.front());
        commands.pop_front();
      }
      const bool result = execute(command);
      command.completion->set_value(result);
      std::fill(command.text.begin(), command.text.end(), '\0');
      if (stopping.load()) return;
    }
  }

  void failPendingCommands() {
    std::deque<Command> pending;
    {
      std::lock_guard<std::mutex> lock(commandMutex);
      running = false;
      pending.swap(commands);
    }
    for (auto& command : pending) {
      std::fill(command.text.begin(), command.text.end(), '\0');
      command.completion->set_value(false);
    }
    commandCv.notify_all();
  }

  void cleanup() {
    if (instance) {
      if (connected) freerdp_disconnect(instance);
      connected = false;
      if (instance->context && instance->context->pubSub) {
        PubSub_UnsubscribeChannelConnected(instance->context->pubSub, channelConnected);
        PubSub_UnsubscribeChannelDisconnected(instance->context->pubSub, channelDisconnected);
      }
      if (instance->context && instance->context->settings)
        freerdp_settings_set_string(instance->context->settings, FreeRDP_Password, "");
      if (instance->context && instance->context->gdi) gdi_free(instance);
      if (instance->context) freerdp_context_free(instance);
      freerdp_free(instance);
      instance = nullptr;
    }
    cliprdr = nullptr;
    disp = nullptr;
    displayControlReady = false;
    maximumMonitorArea = 0;
    active = nullptr;
    std::fill(clipboardText.begin(), clipboardText.end(), '\0');
    clipboardText.clear();
    pendingClipboardRequests.clear();
    failPendingCommands();
  }

  void run(std::shared_ptr<std::promise<bool>> initialized) {
    if (!initialize()) {
      initialized->set_value(false);
      cleanup();
      return;
    }
    {
      std::lock_guard<std::mutex> lock(commandMutex);
      running = true;
    }
    initialized->set_value(true);
    if (!waitForPassword()) {
      cleanup();
      return;
    }
    if (!freerdp_connect(instance)) {
      if (!stopping.load())
        emitState("failed", certificateRejected ? "CERTIFICATE_REJECTED" : "NETWORK_ERROR");
      cleanup();
      return;
    }
    connected = true;
    if (instance->context && instance->context->gdi) endPaint(instance->context);
    emitState("ready", nullptr);
    bool transportOk = true;
    while (!stopping.load()) {
      processCommands();
      if (stopping.load()) break;
      if (!freerdp_check_fds(instance)) {
        transportOk = false;
        break;
      }
      std::unique_lock<std::mutex> lock(commandMutex);
      commandCv.wait_for(lock, std::chrono::milliseconds(2),
                         [&] { return stopping.load() || !commands.empty(); });
    }
    if (!transportOk && !stopping.load()) emitState("failed", "NETWORK_ERROR");
    cleanup();
  }

  bool submit(Command command) {
    auto completion = std::make_shared<std::promise<bool>>();
    auto result = completion->get_future();
    command.completion = completion;
    {
      std::lock_guard<std::mutex> lock(commandMutex);
      if (!running || stopping.load()) return false;
      commands.emplace_back(std::move(command));
    }
    commandCv.notify_all();
    return result.get();
  }
#endif
};

FreeRdpAdapter::FreeRdpAdapter() : impl_(new Impl()) {}

FreeRdpAdapter::~FreeRdpAdapter() {
  close();
  delete impl_;
  impl_ = nullptr;
}

bool FreeRdpAdapter::start(Config config, StateCallback state, PromptCallback prompt,
                           FrameCallback frame, ClipboardCallback clipboard) {
  if (!impl_) return false;
  impl_->config = std::move(config);
  impl_->state = std::move(state);
  impl_->prompt = std::move(prompt);
  impl_->frame = std::move(frame);
  impl_->clipboard = std::move(clipboard);
#if OFS_RDP_HAS_FREERDP
  if (impl_->eventThread.joinable()) return false;
  auto initialized = std::make_shared<std::promise<bool>>();
  auto result = initialized->get_future();
  impl_->eventThread = std::thread([this, initialized] { impl_->run(initialized); });
  const bool ok = result.get();
  if (!ok && impl_->eventThread.joinable()) impl_->eventThread.join();
  return ok;
#else
  (void)config;
  return false;
#endif
}

bool FreeRdpAdapter::providePassword(std::string_view password) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::password;
  command.text.assign(password.data(), password.size());
  return impl_->submit(std::move(command));
#else
  (void)password;
  return false;
#endif
}

bool FreeRdpAdapter::provideCertificate(std::uint32_t requestId, bool accept) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_ || requestId == 0) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::certificate;
  command.requestId = requestId;
  command.value = accept;
  return impl_->submit(std::move(command));
#else
  (void)requestId;
  (void)accept;
  return false;
#endif
}

bool FreeRdpAdapter::resize(Display display) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::resize;
  command.display = display;
  return impl_->submit(std::move(command));
#else
  (void)display;
  return false;
#endif
}

bool FreeRdpAdapter::key(std::uint32_t scanCode, bool pressed, bool extended,
                         std::optional<std::uint32_t> unicode) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::key;
  command.scanCode = scanCode;
  command.value = pressed;
  command.extended = extended;
  command.unicode = unicode;
  return impl_->submit(std::move(command));
#else
  (void)scanCode;
  (void)pressed;
  (void)extended;
  (void)unicode;
  return false;
#endif
}

bool FreeRdpAdapter::pointer(std::uint32_t x, std::uint32_t y, std::uint32_t buttons,
                             std::int32_t wheelX, std::int32_t wheelY) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::pointer;
  command.x = x;
  command.y = y;
  command.buttons = buttons;
  command.wheelX = wheelX;
  command.wheelY = wheelY;
  return impl_->submit(std::move(command));
#else
  (void)x;
  (void)y;
  (void)buttons;
  (void)wheelX;
  (void)wheelY;
  return false;
#endif
}

bool FreeRdpAdapter::clipboardSet(std::string_view text) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::clipboardSet;
  command.text.assign(text.data(), text.size());
  return impl_->submit(std::move(command));
#else
  (void)text;
  return false;
#endif
}

bool FreeRdpAdapter::clipboardGet(std::uint32_t requestId) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_ || requestId == 0) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::clipboardGet;
  command.requestId = requestId;
  return impl_->submit(std::move(command));
#else
  (void)requestId;
  return false;
#endif
}

void FreeRdpAdapter::close() {
  if (!impl_) return;
#if OFS_RDP_HAS_FREERDP
  if (impl_->eventThread.joinable()) {
    Impl::Command command;
    command.kind = Impl::CommandKind::stop;
    impl_->submit(std::move(command));
    impl_->commandCv.notify_all();
    impl_->eventThread.join();
  }
#endif
}
