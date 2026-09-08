#include "freerdp_adapter.h"

#include "unicode.h"
#include "file_clipboard.h"
#include "frame_protocol.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <future>
#include <iomanip>
#include <iostream>
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
#include <freerdp/channels/rdpsnd.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/cmdline.h>
#include <freerdp/client/disp.h>
#include <freerdp/event.h>
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/input.h>
#include <freerdp/settings.h>
#include <freerdp/utils/cliprdr_utils.h>
#include <winpr/crt.h>
#include <winpr/wlog.h>
#if defined(_WIN32)
#include <mmsystem.h>
#include <winpr/winsock.h>
#endif
#endif

struct FreeRdpAdapter::Impl {
  Config config;
  StateCallback state;
  PromptCallback prompt;
  FrameCallback frame;
  ClipboardCallback clipboard;
  ClipboardProgressCallback clipboardProgress;
  RemoteFilesCallback remoteFiles;
  AudioCallback audio;

#if OFS_RDP_HAS_FREERDP
  enum class CommandKind {
    password,
    certificate,
    resize,
    key,
    pointer,
    clipboardSet,
    clipboardGet,
    clipboardFilesSet,
    remoteFileRead,
    setClipboardSync,
    localClipboardChanged,
    remoteFilesDownload,
    stop
  };

  struct Command {
    CommandKind kind = CommandKind::stop;
    std::shared_ptr<std::promise<bool>> completion;
    std::string text;
    std::vector<ClipboardFile> files;
    Display display;
    std::uint64_t generation = 0;
    std::uint64_t offset = 0;
    std::shared_ptr<std::vector<std::uint8_t>> bytes;
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
  int fileListResponse = 0;
  std::unique_ptr<ofs::rdp::FileClipboard> nativeClipboard;
  std::uint64_t remoteGeneration = 0;
  std::uint32_t remoteDescriptorId = 0;
  std::uint64_t descriptorGeneration = 0;
  bool descriptorPending = false;
  std::uint32_t remoteStreamId = 0;
  int remoteReadStatus = 0;
  std::vector<std::uint8_t> remoteReadData;
  std::uint32_t remoteReadCount = 0;
  DispClientContext* disp = nullptr;
  bool connected = false;
  bool displayControlReady = false;
  std::uint64_t maximumMonitorArea = 0;
  bool certificateRejected = false;
  bool winsockInitialized = false;
  std::uint32_t nextSequence = 0;
  std::uint32_t nextCertificateRequest = 1;
  std::uint32_t pendingCertificateRequest = 0;
  std::string clipboardText;
  std::vector<ClipboardFile> clipboardFiles;
  std::vector<std::uint64_t> clipboardFileTransferred;
  std::vector<std::vector<std::pair<std::uint64_t, std::uint64_t>>> clipboardFileRanges;
  std::vector<std::uint8_t> clipboardFileDescriptorData;
  std::uint32_t clipboardFileDescriptorFormatId = 0;
  std::uint32_t clipboardFileContentsFormatId = 0;
  std::uint64_t clipboardTotalTransferred = 0;
  std::uint64_t clipboardTotal = 0;
  bool clipboardTransferActive = false;
  std::chrono::steady_clock::time_point clipboardTransferStarted;
  std::deque<std::uint32_t> pendingClipboardRequests;
  std::uint32_t remoteTextFormatId = 0;
  std::uint32_t lastButtons = 0;
  // Manifest of the current remote file clipboard selection. Parsed from the
  // FileGroupDescriptorW payload when it is published locally, and used by the
  // explicit "download to folder" command.
  std::vector<RemoteFileEntry> remoteClipboardFiles;
  // True while an explicit remote->local download command is running.
  bool remoteDownloadActive = false;
  // Automatic mirroring gate (renderer reports "RDP tab active + window
  // focused"). Written on the event thread, read by the clipboard monitor
  // thread, so both are atomic.
  std::atomic_bool autoClipboardSync{false};
  // Sequence number recorded right after a remote->local write so the monitor
  // can recognize its own clipboard echo and not mirror it back to the server.
  std::atomic_uint32_t lastLocalWriteSeq{0};
  // Set while an automatic remote text pull is in flight (event thread only).
  bool autoTextPullPending = false;
#if defined(_WIN32)
  std::unique_ptr<ofs::rdp::LocalClipboardMonitor> localClipboardMonitor;
#endif
  bool audioChannelConnected = false;
  static inline Impl* active = nullptr;

  static constexpr std::uint32_t kMaxFramePayload = ofs::rdp::frame::kMaxPayload;
  static constexpr std::uint32_t kFrameHeaderSize = ofs::rdp::frame::kFrameHeaderSize;
  static constexpr std::uint32_t kRectHeaderSize = ofs::rdp::frame::kRectHeaderSize;
  static constexpr std::uint32_t kMaxFrameRects = ofs::rdp::frame::kMaxFrameRects;

  static Impl* self(freerdp* value) {
    return active && value == active->instance ? active : nullptr;
  }

  static bool isAudioChannel(const char* name) {
    if (!name) return false;
    if (std::strcmp(name, RDPSND_CHANNEL_NAME) == 0) return true;
#if defined(RDPSND_DVC_CHANNEL_NAME)
    if (std::strcmp(name, RDPSND_DVC_CHANNEL_NAME) == 0) return true;
#endif
#if defined(RDPSND_LOSSY_DVC_CHANNEL_NAME)
    if (std::strcmp(name, RDPSND_LOSSY_DVC_CHANNEL_NAME) == 0) return true;
#endif
    return false;
  }

  void emitAudio(const char* stateValue, const char* errorCode) {
    if (audio) audio(stateValue, errorCode);
  }

  static BOOL preConnect(freerdp* value) {
    Impl* self = Impl::self(value);
    if (!self) return FALSE;
    if (PubSub_SubscribeChannelConnected(value->context->pubSub, channelConnected) < 0 ||
        PubSub_SubscribeChannelDisconnected(value->context->pubSub, channelDisconnected) < 0) {
      std::cerr << "[rdp-worker] FreeRDP channel subscription failed\n";
      std::cerr.flush();
      return FALSE;
    }
    // This loader registers cliprdr as a static channel and disp through
    // drdynvc according to the settings frozen during initialize().
    if (!freerdp_client_load_addins(value->context->channels, value->context->settings)) {
      std::cerr << "[rdp-worker] FreeRDP channel add-in loading failed\n";
      std::cerr.flush();
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
      self->cliprdr->MonitorReady = clipboardMonitorReady;
      self->cliprdr->ServerFormatList = serverFormatList;
      self->cliprdr->ServerFormatDataRequest = serverFormatDataRequest;
      self->cliprdr->ServerFormatDataResponse = serverFormatDataResponse;
      self->cliprdr->ServerFileContentsRequest = serverFileContentsRequest;
      self->cliprdr->ServerFormatListResponse = serverFormatListResponse;
      self->cliprdr->ServerFileContentsResponse = serverFileContentsResponse;
    } else if (std::strcmp(event->name, DISP_DVC_CHANNEL_NAME) == 0) {
      self->disp = static_cast<DispClientContext*>(event->pInterface);
      if (self->disp) {
        self->disp->custom = self;
        self->disp->DisplayControlCaps = displayControlCaps;
      }
    } else if (isAudioChannel(event->name)) {
      self->audioChannelConnected = true;
      self->emitAudio("connected", nullptr);
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
    } else if (isAudioChannel(event->name)) {
      self->audioChannelConnected = false;
      self->emitAudio("stopped", nullptr);
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

  static UINT clipboardMonitorReady(CliprdrClientContext* context,
                                      const CLIPRDR_MONITOR_READY*) {
    if (!context || !context->ClientCapabilities || !context->ClientFormatList) return 1;
    CLIPRDR_GENERAL_CAPABILITY_SET general{};
    general.capabilitySetType = CB_CAPSTYPE_GENERAL;
    general.capabilitySetLength = CB_CAPSTYPE_GENERAL_LEN;
    general.version = CB_CAPS_VERSION_2;
    general.generalFlags = CB_USE_LONG_FORMAT_NAMES | CB_STREAM_FILECLIP_ENABLED |
        CB_FILECLIP_NO_FILE_PATHS | CB_HUGE_FILE_SUPPORT_ENABLED;
    CLIPRDR_CAPABILITIES caps{};
    caps.common.msgType = CB_CLIP_CAPS;
    caps.cCapabilitiesSets = 1;
    caps.capabilitySets = reinterpret_cast<CLIPRDR_CAPABILITY_SET*>(&general);
    const auto result = context->ClientCapabilities(context, &caps);
    if (result != 0) return result;
    CLIPRDR_FORMAT_LIST list{};
    list.common.msgType = CB_FORMAT_LIST;
    return context->ClientFormatList(context, &list);
  }

  static UINT serverFormatListResponse(CliprdrClientContext* context,
                                       const CLIPRDR_FORMAT_LIST_RESPONSE* response) {
    auto* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (!self || !response) return 1;
    self->fileListResponse = (response->common.msgFlags & CB_RESPONSE_OK) ? 1 : -1;
    return 0;
  }

  static UINT serverFormatList(CliprdrClientContext* context,
                               const CLIPRDR_FORMAT_LIST* formatList) {
    auto* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (!self || !formatList) return 1;
    ++self->remoteGeneration;
    self->remoteDescriptorId = 0;
    if (self->nativeClipboard) self->nativeClipboard->clear();
    self->remoteTextFormatId = 0;
    for (UINT32 i = 0; i < formatList->numFormats; ++i) {
      const auto& format = formatList->formats[i];
      if (format.formatName && std::strcmp(format.formatName, "FileGroupDescriptorW") == 0)
        self->remoteDescriptorId = format.formatId;
      // CF_UNICODETEXT is the canonical Windows text clipboard format. Some
      // servers (xrdp, non-Windows stacks) advertise a differently-numbered
      // text format id; remember it so a later text pull asks for the format
      // the server actually offered instead of hardcoding 13.
      else if (self->remoteTextFormatId == 0 && format.formatName &&
               std::strcmp(format.formatName, "CF_UNICODETEXT") == 0)
        self->remoteTextFormatId = format.formatId;
      else if (self->remoteTextFormatId == 0 && format.formatId == 13)
        self->remoteTextFormatId = format.formatId;
    }
    CLIPRDR_FORMAT_LIST_RESPONSE response{};
    response.common.msgType = CB_FORMAT_LIST_RESPONSE;
    response.common.msgFlags = CB_RESPONSE_OK;
    if (context->ClientFormatListResponse) context->ClientFormatListResponse(context, &response);
    // Automatic remote->local mirroring runs only while the RDP tab is focused,
    // so a background session never overwrites the user's local clipboard.
    // - Files: publish the selection into the local OLE clipboard.
    // - Text:  pull the announced text and write it into the local clipboard.
    // Manual Ctrl+C (clipboardGet) uses the same pull paths and works whether
    // or not auto-sync is enabled.
    if (self->autoClipboardSync.load() && self->cliprdr) {
      self->requestRemoteDescriptors();
      if (self->remoteDescriptorId == 0 && !self->descriptorPending &&
          !self->autoTextPullPending && self->pendingClipboardRequests.empty() &&
          self->cliprdr->ClientFormatDataRequest) {
        const std::uint32_t textId = self->remoteTextFormatId ? self->remoteTextFormatId : 13;
        self->autoTextPullPending = true;
        CLIPRDR_FORMAT_DATA_REQUEST request{};
        request.common.msgType = CB_FORMAT_DATA_REQUEST;
        request.common.dataLen = sizeof(request.requestedFormatId);
        request.requestedFormatId = textId;
        if (self->cliprdr->ClientFormatDataRequest(self->cliprdr, &request) != 0)
          self->autoTextPullPending = false;
      }
    }
    return 0;
  }

  static UINT serverFormatDataRequest(CliprdrClientContext* context,
                                      const CLIPRDR_FORMAT_DATA_REQUEST* request) {
    Impl* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (!self || !request || !context->ClientFormatDataResponse)
      return 1;
    if (request->requestedFormatId == self->clipboardFileDescriptorFormatId &&
        !self->clipboardFileDescriptorData.empty()) {
      CLIPRDR_FORMAT_DATA_RESPONSE response{};
      response.common.msgType = CB_FORMAT_DATA_RESPONSE;
      response.common.msgFlags = CB_RESPONSE_OK;
      response.common.dataLen = static_cast<UINT32>(self->clipboardFileDescriptorData.size());
      response.requestedFormatData = self->clipboardFileDescriptorData.data();
      const UINT result = context->ClientFormatDataResponse(context, &response);
      if (result == 0 && self->clipboardTotal == 0 && self->clipboardTransferActive) {
        self->clipboardTransferActive = false;
        if (self->clipboardProgress) self->clipboardProgress("completed", 0,
            static_cast<std::uint32_t>(self->clipboardFiles.size()), nullptr, 0, 0, 0.0, nullptr);
      }
      return result;
    }
    if (request->requestedFormatId != 13) return 1;
    std::vector<std::uint8_t> utf16;
    if (!ofs::rdp::utf8ToUtf16Le(self->clipboardText, utf16)) return 1;
    CLIPRDR_FORMAT_DATA_RESPONSE response{};
    response.common.msgType = CB_FORMAT_DATA_RESPONSE;
    response.common.msgFlags = CB_RESPONSE_OK;
    response.common.dataLen = static_cast<UINT32>(utf16.size());
    response.requestedFormatData = utf16.data();
    return context->ClientFormatDataResponse(context, &response);
  }

  void requestRemoteDescriptors() {
    if (!remoteDescriptorId || descriptorPending || !pendingClipboardRequests.empty() ||
        !cliprdr || !cliprdr->ClientFormatDataRequest) return;
    descriptorPending = true;
    descriptorGeneration = remoteGeneration;
    CLIPRDR_FORMAT_DATA_REQUEST request{};
    request.common.msgType = CB_FORMAT_DATA_REQUEST;
    request.requestedFormatId = remoteDescriptorId;
    if (cliprdr->ClientFormatDataRequest(cliprdr, &request) != 0) descriptorPending = false;
  }

  static UINT serverFileContentsResponse(CliprdrClientContext* context,
                                         const CLIPRDR_FILE_CONTENTS_RESPONSE* response) {
    auto* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (!self || !response) return 1;
    if (response->streamId != self->remoteStreamId || self->remoteReadStatus != 0) return 0;
    self->remoteReadStatus = -1;
    if ((response->common.msgFlags & CB_RESPONSE_OK) && response->cbRequested <= self->remoteReadCount &&
        (response->cbRequested == 0 || response->requestedData)) {
      self->remoteReadData.clear();
      if (response->cbRequested) self->remoteReadData.assign(response->requestedData, response->requestedData + response->cbRequested);
      self->remoteReadStatus = 1;
    }
    return 0;
  }

  static UINT serverFormatDataResponse(CliprdrClientContext* context,
                                       const CLIPRDR_FORMAT_DATA_RESPONSE* response) {
    Impl* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (self && response && self->descriptorPending) {
      self->descriptorPending = false;
      const auto generation = self->descriptorGeneration;
      if (generation != self->remoteGeneration) { self->requestRemoteDescriptors(); return 0; }
      if ((response->common.msgFlags & CB_RESPONSE_OK) && response->requestedFormatData &&
          response->common.dataLen <= 4 + 64 * 592) {
        if (!self->nativeClipboard) self->nativeClipboard = std::make_unique<ofs::rdp::FileClipboard>();
        // Record the plain manifest (name/size/directory per entry) so the
        // renderer can offer an explicit "download to folder" action, and so
        // the download command can iterate the selection without re-parsing
        // the FILEDESCRIPTORW payload.
        const auto* bytes = response->requestedFormatData;
        const auto dataLen = response->common.dataLen;
        self->remoteClipboardFiles.clear();
        if (dataLen >= 4) {
          UINT count = 0;
          std::memcpy(&count, bytes, 4);
          if (count <= 64 && dataLen == 4 + static_cast<std::size_t>(count) * sizeof(FILEDESCRIPTORW)) {
            self->remoteClipboardFiles.reserve(count);
            for (UINT i = 0; i < count; ++i) {
              const auto& descriptor = reinterpret_cast<const FILEDESCRIPTORW*>(bytes + 4)[i];
              const auto* nameStart = descriptor.cFileName;
              const auto* nameEnd = nameStart + sizeof(descriptor.cFileName) / sizeof(descriptor.cFileName[0]);
              const auto* terminator = std::find(nameStart, nameEnd, WCHAR(0));
              std::wstring wideName(nameStart, terminator);
              std::string utf8Name;
              // Strip a "\\server\share" or drive prefix if present: entries in
              // a file clipboard may carry a path prefix depending on how the
              // remote Explorer built the descriptor list.
              const auto slash = wideName.find_last_of(L'\\');
              if (slash != std::wstring::npos) wideName = wideName.substr(slash + 1);
              const auto utf8Length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                  wideName.data(), static_cast<int>(wideName.size()), nullptr, 0, nullptr, nullptr);
              if (utf8Length > 0) {
                utf8Name.resize(static_cast<std::size_t>(utf8Length));
                WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                    wideName.data(), static_cast<int>(wideName.size()),
                    utf8Name.data(), utf8Length, nullptr, nullptr);
              }
              const auto size = (static_cast<std::uint64_t>(descriptor.nFileSizeHigh) << 32) |
                                descriptor.nFileSizeLow;
              if (!utf8Name.empty() && ofs::rdp::clipboardFileNameSafeUtf8(
                      utf8Name.data(), utf8Name.size()))
                self->remoteClipboardFiles.push_back(
                    {std::move(utf8Name), size,
                     (descriptor.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0});
            }
          }
        }
        self->nativeClipboard->publish(
            {bytes, bytes + dataLen},
            [self, generation](std::uint32_t index, std::uint64_t offset, std::uint32_t count,
                               std::vector<std::uint8_t>& bytes) {
              Command command;
              command.kind = CommandKind::remoteFileRead;
              command.generation = generation; command.offset = offset;
              command.x = index; command.y = count;
              command.bytes = std::make_shared<std::vector<std::uint8_t>>();
              auto result = command.bytes;
              if (!self->submit(std::move(command))) return false;
              bytes = std::move(*result); return true;
            });
        if (self->remoteFiles) {
          self->remoteFiles(self->remoteClipboardFiles);
        }
      }
      return 0;
    }
    if (!self || !response || !response->requestedFormatData ||
        response->common.dataLen > 4u * 1024u * 1024u)
      return 1;
    std::string text;
    if (!ofs::rdp::utf16LeToUtf8(response->requestedFormatData,
                                 response->common.dataLen, text))
      return 1;
    std::uint32_t requestId = 0;
    if (!self->pendingClipboardRequests.empty()) {
      requestId = self->pendingClipboardRequests.front();
      self->pendingClipboardRequests.pop_front();
    }
    if (requestId != 0 && self->clipboard) self->clipboard(requestId, std::move(text), false);
    else if (self->autoTextPullPending && self->autoClipboardSync.load() && !text.empty()) {
      // Automatic remote->local text mirroring (no manual Ctrl+C involved).
      // Write straight into the local system clipboard; remember the sequence
      // number so the local clipboard monitor ignores this echo and does not
      // mirror it back to the server.
      self->autoTextPullPending = false;
      // If the server is echoing back text we already advertised, do not write
      // it again: that would only re-trigger the local monitor in a loop.
      if (text != self->clipboardText) {
        const std::uint32_t sequence = ofs::rdp::writeLocalClipboardText(text);
        if (sequence != 0) self->lastLocalWriteSeq.store(sequence);
      }
    }
    self->autoTextPullPending = false;
    self->requestRemoteDescriptors();
    return 0;
  }

  static void failClipboardTransfer(Impl* self, std::uint32_t fileIndex, const char* errorCode) {
    if (!self || !self->clipboardTransferActive) return;
    self->clipboardTransferActive = false;
    if (self->clipboardProgress) {
      const char* fileName = fileIndex < self->clipboardFiles.size()
          ? self->clipboardFiles[fileIndex].name.c_str() : nullptr;
      self->clipboardProgress("failed", fileIndex < self->clipboardFiles.size() ? fileIndex + 1u : 0u,
                              static_cast<std::uint32_t>(self->clipboardFiles.size()), fileName,
                              self->clipboardTotalTransferred, self->clipboardTotal, 0.0,
                              errorCode ? errorCode : "FILE_TRANSFER_FAILED");
    }
  }

  static UINT sendFileContentsFailure(Impl* self, CliprdrClientContext* context,
                                      std::uint32_t streamId, std::uint32_t fileIndex = 0) {
    failClipboardTransfer(self, fileIndex, "FILE_READ_FAILED");
    if (!context || !context->ClientFileContentsResponse) return 1;
    CLIPRDR_FILE_CONTENTS_RESPONSE response{};
    response.common.msgType = CB_FILECONTENTS_RESPONSE;
    response.common.msgFlags = CB_RESPONSE_FAIL;
    response.streamId = streamId;
    return context->ClientFileContentsResponse(context, &response);
  }

  static bool fillFileDescriptor(const ClipboardFile& file, FILEDESCRIPTORW& descriptor) {
    descriptor = FILEDESCRIPTORW{};
    if (file.size > std::numeric_limits<std::uint64_t>::max()) return false;
    descriptor.dwFlags = FD_FILESIZE | FD_UNICODE | FD_ATTRIBUTES;
    descriptor.dwFileAttributes = file.directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
    descriptor.nFileSizeHigh = static_cast<DWORD>(file.size >> 32);
    descriptor.nFileSizeLow = static_cast<DWORD>(file.size & 0xffffffffu);
    std::vector<std::uint8_t> utf16;
    if (!ofs::rdp::utf8ToUtf16Le(file.name, utf16, false) || utf16.size() > 259u * 2u) return false;
    for (std::size_t index = 0; index < utf16.size() / 2u; ++index) {
      descriptor.cFileName[index] = static_cast<WCHAR>(
          static_cast<std::uint16_t>(utf16[index * 2u]) |
          (static_cast<std::uint16_t>(utf16[index * 2u + 1u]) << 8));
    }
    return true;
  }

  static UINT serverFileContentsRequest(CliprdrClientContext* context,
                                         const CLIPRDR_FILE_CONTENTS_REQUEST* request) {
    Impl* self = context ? static_cast<Impl*>(context->custom) : nullptr;
    if (!self || !request || !context || !context->ClientFileContentsResponse) {
      if (self) failClipboardTransfer(self, 0, "FILE_TRANSFER_FAILED");
      return 1;
    }
    if (request->listIndex >= self->clipboardFiles.size())
      return sendFileContentsFailure(self, context, request->streamId);
    const bool sizeRequest = (request->dwFlags & FILECONTENTS_SIZE) != 0;
    const bool rangeRequest = (request->dwFlags & FILECONTENTS_RANGE) != 0;
    if (sizeRequest == rangeRequest) return sendFileContentsFailure(
        self, context, request->streamId, request->listIndex);

    const auto& file = self->clipboardFiles[request->listIndex];
    std::vector<std::uint8_t> data;
    std::uint64_t offset = (static_cast<std::uint64_t>(request->nPositionHigh) << 32) |
                           request->nPositionLow;
    if (sizeRequest) {
      data.resize(sizeof(std::uint64_t));
      for (std::size_t index = 0; index < sizeof(std::uint64_t); ++index)
        data[index] = static_cast<std::uint8_t>(file.size >> (index * 8u));
    } else {
      constexpr std::uint32_t kMaxFileChunk = 1024u * 1024u;
      if (request->cbRequested > kMaxFileChunk || offset > file.size)
        return sendFileContentsFailure(self, context, request->streamId, request->listIndex);
      const auto count = static_cast<std::uint32_t>(std::min<std::uint64_t>(
          request->cbRequested, file.size - offset));
      if (count > 0) {
        std::error_code fileSizeError;
        const auto currentSize = std::filesystem::file_size(
            std::filesystem::u8path(file.path), fileSizeError);
        if (fileSizeError || currentSize != file.size)
          return sendFileContentsFailure(self, context, request->streamId, request->listIndex);
        std::ifstream input(std::filesystem::u8path(file.path), std::ios::binary);
        if (!input) return sendFileContentsFailure(self, context, request->streamId, request->listIndex);
        input.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
        if (!input) return sendFileContentsFailure(self, context, request->streamId, request->listIndex);
        data.resize(count);
        input.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(count));
        const auto actual = static_cast<std::size_t>(input.gcount());
        if (actual != count) return sendFileContentsFailure(self, context, request->streamId, request->listIndex);
        data.resize(actual);
      }
    }

    CLIPRDR_FILE_CONTENTS_RESPONSE response{};
    response.common.msgType = CB_FILECONTENTS_RESPONSE;
    response.common.msgFlags = CB_RESPONSE_OK;
    response.streamId = request->streamId;
    response.cbRequested = static_cast<UINT32>(data.size());
    response.requestedData = data.data();
    const UINT result = context->ClientFileContentsResponse(context, &response);
    if (result != 0) {
      failClipboardTransfer(self, request->listIndex, "FILE_TRANSFER_FAILED");
      return result;
    }
    if (!self->clipboardTransferActive) return result;

    // A zero-byte file has no range request on some Windows clients. Once
    // its size has been acknowledged, the all-zero transfer is complete.
    if (sizeRequest && self->clipboardTotal == 0) {
      if (self->clipboardProgress) {
        self->clipboardProgress("completed", static_cast<std::uint32_t>(request->listIndex + 1u),
                                static_cast<std::uint32_t>(self->clipboardFiles.size()),
                                file.name.c_str(), 0, 0, 0.0, nullptr);
      }
      self->clipboardTransferActive = false;
      return result;
    }
    if (!rangeRequest) return result;

    auto& ranges = self->clipboardFileRanges[request->listIndex];
    if (!data.empty()) {
      const std::uint64_t end = offset + data.size();
      std::pair<std::uint64_t, std::uint64_t> merged{offset, end};
      std::vector<std::pair<std::uint64_t, std::uint64_t>> next;
      next.reserve(ranges.size() + 1u);
      bool inserted = false;
      for (const auto& range : ranges) {
        if (range.second < merged.first) {
          next.emplace_back(range);
        } else if (merged.second < range.first) {
          if (!inserted) {
            next.emplace_back(merged);
            inserted = true;
          }
          next.emplace_back(range);
        } else {
          merged.first = std::min(merged.first, range.first);
          merged.second = std::max(merged.second, range.second);
        }
      }
      if (!inserted) next.emplace_back(merged);
      ranges = std::move(next);
    }
    std::uint64_t covered = 0;
    for (const auto& range : ranges) covered += range.second - range.first;
    self->clipboardFileTransferred[request->listIndex] = std::min(file.size, covered);
    self->clipboardTotalTransferred = 0;
    for (const auto transferred : self->clipboardFileTransferred)
      self->clipboardTotalTransferred += transferred;
    const auto elapsed = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - self->clipboardTransferStarted).count();
    const double speed = elapsed > 0.0 ? self->clipboardTotalTransferred / elapsed : 0.0;
    const bool completed = self->clipboardTotalTransferred >= self->clipboardTotal;
    if (self->clipboardProgress) {
      self->clipboardProgress(completed ? "completed" : "transferring",
                              static_cast<std::uint32_t>(request->listIndex + 1u),
                              static_cast<std::uint32_t>(self->clipboardFiles.size()),
                              file.name.c_str(), self->clipboardTotalTransferred,
                              self->clipboardTotal, speed, nullptr);
    }
    if (completed) self->clipboardTransferActive = false;
    return result;
  }

  static BOOL postConnect(freerdp* value) {
    Impl* self = Impl::self(value);
    if (!self || !value->context || !value->context->update ||
        !gdi_init(value, PIXEL_FORMAT_BGRA32)) {
      std::cerr << "[rdp-worker] FreeRDP GDI initialization failed\n";
      std::cerr.flush();
      return FALSE;
    }
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
    batch.reserve(kMaxFrameRects);
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
            batch.reserve(kMaxFrameRects);
            batchBytes = kFrameHeaderSize;
          }

          Rect rect;
          rect.x = static_cast<std::int32_t>(rectX);
          rect.y = static_cast<std::int32_t>(rectY + copiedRows);
          rect.width = rectWidth;
          rect.height = sliceHeight;
          rect.stride = static_cast<std::uint32_t>(rowBytes);
          rect.pixels.resize(static_cast<std::size_t>(sliceBytes));
          const auto* source = gdi->primary_buffer +
              static_cast<std::uint64_t>(rect.y) * stride +
              static_cast<std::uint64_t>(rect.x) * 4u;
          // FreeRDP's GDI buffer is BGRA32; use its optimized image copy for
          // the wire RGBA8888 conversion instead of swapping every pixel in
          // this callback. The destination is a fresh rectangle buffer, so
          // the non-overlapping copy contract is satisfied.
          if (!freerdp_image_copy(rect.pixels.data(), PIXEL_FORMAT_RGBA32,
                                   static_cast<UINT32>(rowBytes), 0, 0, rectWidth,
                                   sliceHeight, source, PIXEL_FORMAT_BGRA32, stride,
                                   0, 0, nullptr, FREERDP_FLIP_NONE))
            return FALSE;
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

  // FreeRDP may finish the initial connection without marking the GDI window
  // invalid. The embedded client still needs a seed image in that case;
  // otherwise the session can report ready while the renderer has nothing to
  // paint until the remote desktop changes a pixel.
  static BOOL emitFullFrame(rdpContext* context) {
    Impl* self = active;
    if (self && self->instance && self->instance->context != context) self = nullptr;
    if (!self || !context || !context->gdi) return FALSE;
    rdpGdi* gdi = context->gdi;
    if (!gdi->primary_buffer || !gdi->primary || !gdi->primary->bitmap ||
        gdi->width <= 0 || gdi->height <= 0 || gdi->stride <= 0)
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
        framebufferBytes > std::numeric_limits<std::uint32_t>::max())
      return FALSE;

    const std::uint64_t rowBytes = static_cast<std::uint64_t>(width) * 4u;
    const std::uint64_t maxRows =
        (kMaxFramePayload - kFrameHeaderSize - kRectHeaderSize) / rowBytes;
    if (maxRows == 0) return FALSE;

    std::vector<Rect> batch;
    batch.reserve(kMaxFrameRects);
    std::uint64_t batchBytes = kFrameHeaderSize;
    try {
      std::uint32_t copiedRows = 0;
      while (copiedRows < height) {
        const auto sliceHeight = static_cast<std::uint32_t>(std::min<std::uint64_t>(
            height - copiedRows, maxRows));
        const std::uint64_t sliceBytes = rowBytes * sliceHeight;
        if (batch.size() == kMaxFrameRects ||
            batchBytes > kMaxFramePayload - kRectHeaderSize - sliceBytes) {
          if (!self->emitFrame(width, height, std::move(batch))) return FALSE;
          batch = {};
          batch.reserve(kMaxFrameRects);
          batchBytes = kFrameHeaderSize;
        }

        Rect rect;
        rect.x = 0;
        rect.y = static_cast<std::int32_t>(copiedRows);
        rect.width = width;
        rect.height = sliceHeight;
        rect.stride = width * 4u;
        rect.pixels.resize(static_cast<std::size_t>(sliceBytes));
        for (std::uint32_t row = 0; row < sliceHeight; ++row) {
          const auto* source = gdi->primary_buffer +
              (static_cast<std::uint64_t>(copiedRows) + row) * stride;
          auto* destination = rect.pixels.data() + static_cast<std::size_t>(row) * rowBytes;
          // FreeRDP's GDI buffer is BGRA32; the wire format is RGBA8888.
          for (std::uint64_t column = 0; column < rowBytes; column += 4) {
            destination[column] = source[column + 2];
            destination[column + 1] = source[column + 1];
            destination[column + 2] = source[column];
            destination[column + 3] = source[column + 3];
          }
        }
        batchBytes += kRectHeaderSize + sliceBytes;
        batch.emplace_back(std::move(rect));
        copiedRows += sliceHeight;
      }
    } catch (const std::bad_alloc&) {
      return FALSE;
    }
    return batch.empty() ? FALSE : (self->emitFrame(width, height, std::move(batch)) ? TRUE : FALSE);
  }

  static BOOL desktopResize(rdpContext* context) {
    if (!context || !context->gdi || !context->settings) return FALSE;
    const UINT32 width = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopWidth);
    const UINT32 height = freerdp_settings_get_uint32(context->settings, FreeRDP_DesktopHeight);
    if (!gdi_resize(context->gdi, width, height)) return FALSE;
    // gdi_resize() replaces the backing store. The server may follow with
    // only partial invalidations, so publish a complete keyframe immediately
    // or the renderer can retain black pixels outside the next dirty rect.
    return emitFullFrame(context);
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
    std::cerr << "[rdp-worker] certificate decision request=" << requestId
              << " accepted=" << (accepted ? "true" : "false")
              << " changed=" << (changed ? "true" : "false") << '\n';
    std::cerr.flush();
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
    std::cerr << "[rdp-worker] state=" << (value ? value : "(null)");
    if (errorCode) std::cerr << " errorCode=" << errorCode;
    std::cerr << '\n';
    std::cerr.flush();
    if (state) state(value, errorCode);
  }

  const char* connectionErrorCode() const {
    if (certificateRejected) return "CERTIFICATE_REJECTED";
    if (!instance || !instance->context) return "NETWORK_ERROR";
    switch (freerdp_get_last_error(instance->context)) {
      case FREERDP_ERROR_AUTHENTICATION_FAILED:
      case FREERDP_ERROR_CONNECT_LOGON_FAILURE:
      case FREERDP_ERROR_CONNECT_WRONG_PASSWORD:
      case FREERDP_ERROR_CONNECT_ACCESS_DENIED:
      case FREERDP_ERROR_CONNECT_NO_OR_MISSING_CREDENTIALS:
      case FREERDP_ERROR_CONNECT_PASSWORD_EXPIRED:
      case FREERDP_ERROR_CONNECT_PASSWORD_MUST_CHANGE:
      case FREERDP_ERROR_CONNECT_ACCOUNT_DISABLED:
      case FREERDP_ERROR_CONNECT_ACCOUNT_EXPIRED:
      case FREERDP_ERROR_CONNECT_LOGON_TYPE_NOT_GRANTED:
      case FREERDP_ERROR_CONNECT_ACCOUNT_RESTRICTION:
        return "AUTH_FAILED";
      // FreeRDP may report 0x20018 for transient NLA/session state as well as
      // a real Windows lockout.  The worker has no access to the server
      // security log, so preserve the raw code in diagnostics but expose the
      // conservative authentication failure state to the UI.
      case FREERDP_ERROR_CONNECT_ACCOUNT_LOCKED_OUT:
        return "AUTH_FAILED";
      case FREERDP_ERROR_CONNECT_CANCELLED:
        return "CANCELED";
      default:
        return "NETWORK_ERROR";
    }
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
#if defined(_WIN32)
    WSADATA winsockData{};
    if (WSAStartup(MAKEWORD(2, 2), &winsockData) != 0) {
      std::cerr << "[rdp-worker] WSAStartup failed\n";
      std::cerr.flush();
      return false;
    }
    winsockInitialized = true;
#endif
    // The bundled Windows backend is FreeRDP's WinMM device. Probe it before
    // loading channels so a machine without a playback device still gets a
    // working desktop session with audio gracefully disabled.
#if defined(_WIN32)
    bool audioUnavailable = false;
    if (config.audioPlayback && waveOutGetNumDevs() == 0) {
      config.audioPlayback = false;
      audioUnavailable = true;
      emitAudio("unavailable", "AUDIO_DEVICE_UNAVAILABLE");
    }
#else
    constexpr bool audioUnavailable = false;
#endif
    if (audioUnavailable) {
      // The unavailable event already explains why playback was disabled.
    } else if (!config.audioPlayback) {
      emitAudio("disabled", nullptr);
    } else {
      emitAudio("enabled", nullptr);
    }
    // stdout is the binary OFSR protocol stream. FreeRDP's console logger is
    // otherwise allowed to write diagnostic text into that stream on Windows.
    if (wLog* root = WLog_GetRoot()) WLog_SetLogLevel(root, WLOG_OFF);
    instance = freerdp_new();
    if (!instance || !freerdp_context_new(instance)) {
      std::cerr << "[rdp-worker] FreeRDP context initialization failed\n";
      std::cerr.flush();
      return false;
    }
    // freerdp_context_new() creates the core context but does not install the
    // client channel provider. Without it, the static cliprdr and disp
    // add-ins cannot be resolved by freerdp_client_load_addins().
    if (freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0) != 0) {
      std::cerr << "[rdp-worker] FreeRDP static add-in provider registration failed\n";
      std::cerr.flush();
      return false;
    }
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
           freerdp_settings_set_uint32(settings, FreeRDP_ClipboardFeatureMask,
                                       CLIPRDR_FLAG_LOCAL_TO_REMOTE |
                                       CLIPRDR_FLAG_LOCAL_TO_REMOTE_FILES |
                                       CLIPRDR_FLAG_REMOTE_TO_LOCAL |
                                       CLIPRDR_FLAG_REMOTE_TO_LOCAL_FILES) &&
           freerdp_settings_set_bool(settings, FreeRDP_DeviceRedirection, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectDrives, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectSmartCards, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectPrinters, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectSerialPorts, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_RedirectParallelPorts, FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_AudioPlayback,
                                      config.audioPlayback ? TRUE : FALSE) &&
           freerdp_settings_set_bool(settings, FreeRDP_AudioCapture, FALSE) &&
           // FreeRDP's client loader promotes AudioPlayback to rdpdr because
           // rdpsnd is an RDPDR-dependent channel. Other device redirection
           // features remain disabled below.
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
      if (command.completion) command.completion->set_value(result);
      if (command.kind == CommandKind::password) return result;
      if (command.kind == CommandKind::stop) return false;
      lock.lock();
    }
    return false;
  }

  bool sendMonitorLayout(Display next) {
    if (!connected || !instance || !instance->context) return false;
    // Display Control is optional on the remote server. A valid resize from
    // the renderer is still acknowledged when that channel is unavailable;
    // the framebuffer remains usable at the negotiated desktop size.
    if (!disp || !disp->SendMonitorLayout || !displayControlReady) return true;
    if (!waitForChannel([&] { return disp && disp->SendMonitorLayout && displayControlReady; }))
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
        if (!instance->context->input) return false;
        const UINT16 px = static_cast<UINT16>(std::min<std::uint32_t>(command.x, 0xffffu));
        const UINT16 py = static_cast<UINT16>(std::min<std::uint32_t>(command.y, 0xffffu));
        // Keep the position update as a separate PDU. Some Windows RDP
        // servers accept PTR_FLAGS_MOVE combined with a button transition,
        // while others do not reliably dispatch the resulting click to the
        // target window. The separate MOVE -> button sequence is the
        // interoperable behavior used by the previous release.
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
        if (!config.clipboard) return false;
        if (!waitForChannel([&] { return cliprdr && cliprdr->ClientFormatList; }))
          return true;
        if (!cliprdr || !cliprdr->ClientFormatList) return true;
        std::vector<std::uint8_t> validated;
        if (!ofs::rdp::utf8ToUtf16Le(command.text, validated)) return false;
        clipboardText = command.text;
        clipboardFiles.clear();
        clipboardFileTransferred.clear();
        clipboardFileRanges.clear();
        clipboardFileDescriptorData.clear();
        clipboardTransferActive = false;
        clipboardTotalTransferred = 0;
        clipboardTotal = 0;
        CLIPRDR_FORMAT format{};
        format.formatId = 13;
        CLIPRDR_FORMAT_LIST list{};
        list.common.msgType = CB_FORMAT_LIST;
        list.numFormats = 1;
        list.formats = &format;
        return cliprdr->ClientFormatList(cliprdr, &list) == 0;
      }
      case CommandKind::clipboardFilesSet: {
        if (!config.clipboard || command.files.empty() ||
            !waitForChannel([&] { return cliprdr && cliprdr->ClientFormatList; }) ||
            !cliprdr || !cliprdr->ClientFormatList)
          return false;
#if defined(_WIN32)
        const UINT descriptorId = RegisterClipboardFormatW(L"FileGroupDescriptorW");
        const UINT contentsId = RegisterClipboardFormatW(L"FileContents");
        if (descriptorId == 0 || contentsId == 0) return false;
        std::vector<FILEDESCRIPTORW> descriptors(command.files.size());
        for (std::size_t index = 0; index < command.files.size(); ++index) {
          if (!fillFileDescriptor(command.files[index], descriptors[index])) {
            failClipboardTransfer(this, static_cast<std::uint32_t>(index), "FILE_DESCRIPTOR_FAILED");
            return false;
          }
        }
        BYTE* serialized = nullptr;
        UINT32 serializedLength = 0;
        if (cliprdr_serialize_file_list_ex(CB_STREAM_FILECLIP_ENABLED | CB_HUGE_FILE_SUPPORT_ENABLED,
                                            descriptors.data(), static_cast<UINT32>(descriptors.size()),
                                            &serialized, &serializedLength) != 0 || !serialized) {
          failClipboardTransfer(this, 0, "FILE_DESCRIPTOR_FAILED");
          return false;
        }
        clipboardFiles = std::move(command.files);
        clipboardFileTransferred.assign(clipboardFiles.size(), 0);
        clipboardFileRanges.assign(clipboardFiles.size(), {});
        clipboardFileDescriptorData.assign(serialized, serialized + serializedLength);
        free(serialized);
        clipboardFileDescriptorFormatId = descriptorId;
        clipboardFileContentsFormatId = contentsId;
        clipboardText.clear();
        clipboardTotal = 0;
        for (const auto& file : clipboardFiles) clipboardTotal += file.size;
        clipboardTotalTransferred = 0;
        clipboardTransferStarted = std::chrono::steady_clock::now();
        clipboardTransferActive = true;
        CLIPRDR_FORMAT formats[2]{};
        formats[0].formatId = descriptorId;
        formats[0].formatName = const_cast<char*>("FileGroupDescriptorW");
        formats[1].formatId = contentsId;
        formats[1].formatName = const_cast<char*>("FileContents");
        CLIPRDR_FORMAT_LIST list{};
        list.common.msgType = CB_FORMAT_LIST;
        list.numFormats = 2;
        list.formats = formats;
        if (clipboardProgress) clipboardProgress("preparing", 0,
                                                  static_cast<std::uint32_t>(clipboardFiles.size()),
                                                  nullptr, 0, clipboardTotal, 0.0, nullptr);
        fileListResponse = 0;
        const bool sent = cliprdr->ClientFormatList(cliprdr, &list) == 0 &&
            waitForChannel([&] { return fileListResponse != 0; }) && fileListResponse == 1;
        if (!sent) failClipboardTransfer(this, 0, "CLIPBOARD_CHANNEL_FAILED");
        return sent;
#else
        return false;
#endif
      }
      case CommandKind::remoteFileRead: {
        if (command.generation != remoteGeneration || !remoteDescriptorId || !cliprdr ||
            !cliprdr->ClientFileContentsRequest || command.y > 1024 * 1024) return false;
        CLIPRDR_FILE_CONTENTS_REQUEST request{};
        request.common.msgType = CB_FILECONTENTS_REQUEST;
        request.streamId = ++remoteStreamId;
        request.listIndex = command.x; request.dwFlags = FILECONTENTS_RANGE;
        request.nPositionLow = static_cast<UINT32>(command.offset);
        request.nPositionHigh = static_cast<UINT32>(command.offset >> 32);
        request.cbRequested = command.y;
        remoteReadStatus = 0; remoteReadCount = command.y;
        if (cliprdr->ClientFileContentsRequest(cliprdr, &request) != 0) return false;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
        while (remoteReadStatus == 0 && !stopping && command.generation == remoteGeneration) {
          if (std::chrono::steady_clock::now() >= deadline || !freerdp_check_fds(instance)) return false;
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        if (remoteReadStatus != 1 || command.generation != remoteGeneration) return false;
        *command.bytes = std::move(remoteReadData); return true;
      }
      case CommandKind::clipboardGet: {
        if (remoteDescriptorId) {
          if (clipboard) clipboard(command.requestId, {}, true);
          requestRemoteDescriptors();
          return true;
        }
        if (!config.clipboard || command.requestId == 0) return false;
        if (!waitForChannel([&] { return cliprdr && cliprdr->ClientFormatDataRequest; })) {
          if (clipboard) clipboard(command.requestId, {}, false);
          return true;
        }
        if (!cliprdr || !cliprdr->ClientFormatDataRequest) {
          if (clipboard) clipboard(command.requestId, {}, false);
          return true;
        }
        pendingClipboardRequests.push_back(command.requestId);
        CLIPRDR_FORMAT_DATA_REQUEST request{};
        request.common.msgType = CB_FORMAT_DATA_REQUEST;
        request.common.dataLen = sizeof(request.requestedFormatId);
        request.requestedFormatId = remoteTextFormatId ? remoteTextFormatId : 13;
        const bool sent = cliprdr->ClientFormatDataRequest(cliprdr, &request) == 0;
        if (!sent) pendingClipboardRequests.pop_back();
        return sent;
      }
      case CommandKind::setClipboardSync: {
        autoClipboardSync.store(command.value);
        // Enabling auto-sync should also mirror whatever the user copied
        // before the RDP tab gained focus. The next WM_CLIPBOARDUPDATE is not
        // guaranteed, so schedule one probe immediately.
        if (command.value) {
          Command probe;
          probe.kind = CommandKind::localClipboardChanged;
          if (!enqueueCommand(std::move(probe))) return true;
        }
        return true;
      }
      case CommandKind::localClipboardChanged: {
        // Local->remote text mirroring while the RDP tab is focused. Files are
        // deliberately excluded: the renderer drives file pastes through the
        // explicit Ctrl+V clipboardFilesSet path with progress feedback.
        if (!config.clipboard || !autoClipboardSync.load()) return true;
        if (!waitForChannel([&] { return cliprdr && cliprdr->ClientFormatList; }))
          return true;
        if (!cliprdr || !cliprdr->ClientFormatList) return true;
        const std::string text = ofs::rdp::readLocalClipboardText();
        if (text.empty()) return true;
        // Skip content we already advertised: this is either our own
        // remote->local write (echo suppression by sequence) or a repeated
        // copy of the same text, neither of which should round-trip again.
        if (text == clipboardText) return true;
        Command inner;
        inner.kind = CommandKind::clipboardSet;
        inner.text = text;
        return execute(inner);
      }
      case CommandKind::remoteFilesDownload: {
        // Explicit remote->local "download to folder": iterate the current
        // remote file clipboard manifest and stream each file into the chosen
        // local directory. Unlike OLE delayed rendering this does not depend
        // on Explorer; the user drives it from the RDP tab.
        if (!config.clipboard || command.files.size() != 1 || command.text.empty() ||
            remoteClipboardFiles.empty() || remoteDescriptorId == 0 || !cliprdr ||
            !cliprdr->ClientFileContentsRequest || remoteDownloadActive)
          return false;
        remoteDownloadActive = true;
        const auto generation = remoteGeneration;
        bool ok = true;
        for (std::size_t index = 0; index < remoteClipboardFiles.size() && ok; ++index) {
          const auto& entry = remoteClipboardFiles[index];
          if (entry.directory) continue;
          const std::string& utf8Name = entry.name;
          if (utf8Name.empty()) { ok = false; break; }
          // Ask the server for the authoritative size; the manifest size can
          // be absent or stale.
          CLIPRDR_FILE_CONTENTS_REQUEST sizeRequest{};
          sizeRequest.common.msgType = CB_FILECONTENTS_REQUEST;
          sizeRequest.streamId = ++remoteStreamId;
          sizeRequest.listIndex = static_cast<UINT32>(index);
          sizeRequest.dwFlags = FILECONTENTS_SIZE;
          remoteReadStatus = 0;
          std::uint64_t fileSize = entry.size;
          if (cliprdr->ClientFileContentsRequest(cliprdr, &sizeRequest) == 0) {
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
            while (remoteReadStatus == 0 && !stopping && generation == remoteGeneration) {
              if (std::chrono::steady_clock::now() >= deadline || !freerdp_check_fds(instance)) {
                ok = false; break;
              }
              std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
            if (ok && remoteReadStatus == 1 && remoteReadData.size() == sizeof(std::uint64_t)) {
              fileSize = 0;
              for (std::size_t byte = 0; byte < sizeof(std::uint64_t); ++byte)
                fileSize |= static_cast<std::uint64_t>(remoteReadData[byte]) << (byte * 8);
            } else if (remoteReadStatus != 1) {
              ok = false;
            }
          }
          if (!ok || generation != remoteGeneration) break;
          std::error_code ioError;
          const auto destination = std::filesystem::u8path(command.text) /
                                   std::filesystem::u8path(utf8Name);
          std::ofstream output(destination, std::ios::binary | std::ios::trunc);
          if (!output) { ok = false; break; }
          std::uint64_t offset = 0;
          while (offset < fileSize && ok) {
            const std::uint32_t chunk = static_cast<std::uint32_t>(
                std::min<std::uint64_t>(fileSize - offset, 1024u * 1024u));
            CLIPRDR_FILE_CONTENTS_REQUEST range{};
            range.common.msgType = CB_FILECONTENTS_REQUEST;
            range.streamId = ++remoteStreamId;
            range.listIndex = static_cast<UINT32>(index);
            range.dwFlags = FILECONTENTS_RANGE;
            range.nPositionLow = static_cast<UINT32>(offset);
            range.nPositionHigh = static_cast<UINT32>(offset >> 32);
            range.cbRequested = chunk;
            remoteReadStatus = 0;
            if (cliprdr->ClientFileContentsRequest(cliprdr, &range) != 0) { ok = false; break; }
            {
              const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
              while (remoteReadStatus == 0 && !stopping && generation == remoteGeneration) {
                if (std::chrono::steady_clock::now() >= deadline || !freerdp_check_fds(instance)) {
                  ok = false; break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
              }
            }
            if (!ok || remoteReadStatus != 1 || generation != remoteGeneration) { ok = false; break; }
            output.write(reinterpret_cast<const char*>(remoteReadData.data()),
                         static_cast<std::streamsize>(remoteReadData.size()));
            if (!output) { ok = false; break; }
            offset += remoteReadData.size();
          }
          output.close();
          if (!ok) { std::filesystem::remove(destination, ioError); break; }
        }
        remoteDownloadActive = false;
        return ok;
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
      if (command.completion) command.completion->set_value(result);
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
      if (command.completion) command.completion->set_value(false);
    }
    commandCv.notify_all();
  }

  void cleanup() {
    if (nativeClipboard) nativeClipboard->clear();
    failPendingCommands();
    nativeClipboard.reset();
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
#if defined(_WIN32)
    if (localClipboardMonitor) {
      localClipboardMonitor->stop();
      localClipboardMonitor.reset();
    }
#endif
    audioChannelConnected = false;
    displayControlReady = false;
    maximumMonitorArea = 0;
    active = nullptr;
    std::fill(clipboardText.begin(), clipboardText.end(), '\0');
    clipboardText.clear();
    clipboardFiles.clear();
    clipboardFileTransferred.clear();
    clipboardFileRanges.clear();
    clipboardFileDescriptorData.clear();
    clipboardFileDescriptorFormatId = 0;
    clipboardFileContentsFormatId = 0;
    clipboardTotalTransferred = 0;
    clipboardTotal = 0;
    clipboardTransferActive = false;
    pendingClipboardRequests.clear();
    failPendingCommands();
#if defined(_WIN32)
    if (winsockInitialized) {
      WSACleanup();
      winsockInitialized = false;
    }
#endif
  }

  void run(std::shared_ptr<std::promise<bool>> initialized) {
    if (!initialize()) {
      std::cerr << "[rdp-worker] backend thread initialization failed\n";
      std::cerr.flush();
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
      const auto lastError = instance && instance->context ? freerdp_get_last_error(instance->context) : 0;
      const char* errorCode = connectionErrorCode();
      std::cerr << "[rdp-worker] freerdp_connect failed: lastError=0x"
                << std::hex << lastError << std::dec << " mapped=" << errorCode << '\n';
      std::cerr.flush();
      if (!stopping.load()) emitState("failed", errorCode);
      cleanup();
      return;
    }
    connected = true;
    if (!instance->context || !emitFullFrame(instance->context)) {
      std::cerr << "[rdp-worker] initial framebuffer publication failed\n";
      std::cerr.flush();
      if (!stopping.load()) emitState("failed", "PROTOCOL_ERROR");
      cleanup();
      return;
    }
    emitState("ready", nullptr);
#if defined(_WIN32)
    if (config.clipboard) {
      // Watches the local system clipboard so text copied locally can be
      // mirrored to the remote desktop automatically while the tab is focused.
      // The callback only enqueues work; all clipboard/FreeRDP access happens
      // on the event thread through the command queue.
      localClipboardMonitor = std::make_unique<ofs::rdp::LocalClipboardMonitor>();
      localClipboardMonitor->start([this] {
        if (!config.clipboard || !autoClipboardSync.load()) return;
        Command command;
        command.kind = CommandKind::localClipboardChanged;
        enqueueCommand(std::move(command));
      });
    }
#endif
    bool transportOk = true;
    while (!stopping.load()) {
      processCommands();
      if (stopping.load()) break;
      if (!freerdp_check_fds(instance)) {
        const auto lastError = instance && instance->context ? freerdp_get_last_error(instance->context) : 0;
        std::cerr << "[rdp-worker] freerdp_check_fds failed: lastError=0x"
                  << std::hex << lastError << std::dec << '\n';
        std::cerr.flush();
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

  static bool isPurePointerMove(const Command& command) {
    return command.kind == CommandKind::pointer && command.wheelX == 0 && command.wheelY == 0;
  }

  bool enqueueCommand(Command command) {
    {
      std::lock_guard<std::mutex> lock(commandMutex);
      if (!running || stopping.load()) return false;
      // Pointer moves are high-frequency state updates. Coalesce only adjacent
      // moves with the same button state; button transitions and wheel events
      // remain ordered and are never discarded.
      if (isPurePointerMove(command) && !commands.empty() &&
          isPurePointerMove(commands.back()) && !commands.back().completion &&
          (commands.back().buttons & 0x7u) == (command.buttons & 0x7u)) {
        commands.back().x = command.x;
        commands.back().y = command.y;
        return true;
      }
      commands.emplace_back(std::move(command));
    }
    commandCv.notify_all();
    return true;
  }

  bool enqueue(Command command) { return enqueueCommand(std::move(command)); }

  bool submit(Command command) {
    auto completion = std::make_shared<std::promise<bool>>();
    auto result = completion->get_future();
    command.completion = completion;
    if (!enqueueCommand(std::move(command))) return false;
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
                            FrameCallback frame, ClipboardCallback clipboard,
                            ClipboardProgressCallback clipboardProgress, AudioCallback audio,
                            RemoteFilesCallback remoteFiles) {
  if (!impl_) return false;
  impl_->config = std::move(config);
  impl_->state = std::move(state);
  impl_->prompt = std::move(prompt);
  impl_->frame = std::move(frame);
  impl_->clipboard = std::move(clipboard);
  impl_->clipboardProgress = std::move(clipboardProgress);
  impl_->audio = std::move(audio);
  impl_->remoteFiles = std::move(remoteFiles);
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
  return impl_->enqueue(std::move(command));
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
  return impl_->enqueue(std::move(command));
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

bool FreeRdpAdapter::clipboardFilesSet(std::vector<ClipboardFile> files) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_ || files.empty()) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::clipboardFilesSet;
  command.files = std::move(files);
  return impl_->submit(std::move(command));
#else
  (void)files;
  return false;
#endif
}

bool FreeRdpAdapter::setClipboardSync(bool enabled) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::setClipboardSync;
  command.value = enabled;
  return impl_->submit(std::move(command));
#else
  (void)enabled;
  return false;
#endif
}

bool FreeRdpAdapter::notifyLocalClipboardChanged() {
#if OFS_RDP_HAS_FREERDP
  if (!impl_) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::localClipboardChanged;
  return impl_->enqueue(std::move(command));
#else
  return false;
#endif
}

bool FreeRdpAdapter::remoteFilesDownload(std::string destinationDir) {
#if OFS_RDP_HAS_FREERDP
  if (!impl_ || destinationDir.empty()) return false;
  Impl::Command command;
  command.kind = Impl::CommandKind::remoteFilesDownload;
  command.text = std::move(destinationDir);
  return impl_->submit(std::move(command));
#else
  (void)destinationDir;
  return false;
#endif
}

std::uint32_t FreeRdpAdapter::remoteClipboardFileCount() const {
#if OFS_RDP_HAS_FREERDP
  if (!impl_) return 0;
  return static_cast<std::uint32_t>(impl_->remoteClipboardFiles.size());
#else
  return 0;
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
