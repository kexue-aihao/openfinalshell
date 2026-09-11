// Run the actual adapter callbacks against a queued CLIPRDR peer. A transport
// read alone cannot deliver queued virtual-channel writes to this peer.
#include <freerdp/freerdp.h>
#include <functional>
#include <cassert>
static std::function<void()> queued;
static unsigned pumps = 0;
static UINT32 connectionError = 0;
static UINT32 testLastError(rdpContext*) { return connectionError; }
static BOOL testCheckEvents(rdpContext*) {
  ++pumps;
  auto next = std::move(queued);
  queued = {};
  if (next) next();
  return TRUE;
}
#define freerdp_check_event_handles testCheckEvents
#define freerdp_get_last_error testLastError
#include "../freerdp_adapter.cpp"
#undef freerdp_check_event_handles
#undef freerdp_get_last_error

struct FreeRdpAdapterTestPeer {
  using Impl = FreeRdpAdapter::Impl;
  static void run() {
    Impl adapter;
    freerdp instance{};
    rdpContext context{};
    instance.context = &context;
    context.instance = &instance;
    adapter.instance = &instance;
    connectionError = FREERDP_ERROR_CONNECT_ACCOUNT_LOCKED_OUT;
    assert(connectionError == 0x20018);
    assert(std::string(adapter.connectionErrorCode()) == "ACCOUNT_LOCKED_OUT");
    connectionError = FREERDP_ERROR_CONNECT_WRONG_PASSWORD;
    assert(std::string(adapter.connectionErrorCode()) == "AUTH_FAILED");
    connectionError = 0;
    adapter.connected = true;
    // Sending a layout must not change negotiated settings before the server
    // reactivation checks them and invokes DesktopResize.
    context.settings = freerdp_settings_new(0);
    assert(context.settings);
    assert(freerdp_settings_set_uint32(context.settings, FreeRDP_DesktopWidth, 1280));
    assert(freerdp_settings_set_uint32(context.settings, FreeRDP_DesktopHeight, 720));
    assert(adapter.sendMonitorLayout({1400, 900, 96}));
    assert(adapter.sendMonitorLayout({1600, 1000, 96}));
    assert(adapter.pendingDisplay->width == 1600);
    DispClientContext display{};
    display.custom = &adapter;
    unsigned layouts = 0;
    display.SendMonitorLayout = [](auto* c, UINT32 count, DISPLAY_CONTROL_MONITOR_LAYOUT* layout) -> UINT {
      auto* calls = static_cast<unsigned*>(c->handle);
      ++*calls;
      assert(count == 1 && layout->Width == 1600 && layout->Height == 1000);
      return 0;
    };
    display.handle = &layouts;
    adapter.disp = &display;
    assert(Impl::displayControlCaps(&display, 1, 8192, 8192) == 0);
    adapter.flushPendingDisplay();
    adapter.flushPendingDisplay();
    assert(layouts == 1 && !adapter.pendingDisplay);
    assert(freerdp_settings_get_uint32(context.settings, FreeRDP_DesktopWidth) == 1280);
    assert(freerdp_settings_get_uint32(context.settings, FreeRDP_DesktopHeight) == 720);
    freerdp_settings_free(context.settings);
    context.settings = nullptr;
    adapter.disp = nullptr;
    adapter.displayControlReady = false;
    adapter.config.clipboard = true;
    CliprdrClientContext clip{};
    clip.custom = &adapter;
    adapter.cliprdr = &clip;
    unsigned progress = 0;
    adapter.clipboardProgress = [&](const char*, auto...) { ++progress; };

    clip.ClientCapabilities = [](auto*, const CLIPRDR_CAPABILITIES* caps) -> UINT {
      const auto* general = reinterpret_cast<const CLIPRDR_GENERAL_CAPABILITY_SET*>(caps->capabilitySets);
      assert(general->generalFlags & CB_STREAM_FILECLIP_ENABLED);
      assert(general->generalFlags & CB_HUGE_FILE_SUPPORT_ENABLED);
      assert(general->generalFlags & CB_FILECLIP_NO_FILE_PATHS);
      return 0;
    };
    clip.ClientFormatList = [](auto* c, const CLIPRDR_FORMAT_LIST* list) -> UINT {
      if (!list->numFormats) return 0;
      assert(list->numFormats == 2);
      assert(std::string(list->formats[0].formatName) == "FileGroupDescriptorW");
      queued = [c] {
        CLIPRDR_FORMAT_LIST_RESPONSE response{};
        response.common.msgFlags = CB_RESPONSE_OK;
        Impl::serverFormatListResponse(c, &response);
      };
      return 0;
    };
    assert(Impl::clipboardMonitorReady(&clip, nullptr) == 0);
    assert(adapter.clipboardReady);
    // A nonexistent source can be advertised: copy must only send metadata.
    Impl::Command upload;
    upload.kind = Impl::CommandKind::clipboardFilesSet;
    upload.files = {{"missing-source.txt", "folder\\hello.txt", 5, false}};
    assert(adapter.execute(upload));
    assert(pumps > 0 && adapter.fileListResponse == 1);
    assert(progress == 1);
    clip.ClientFormatDataResponse = [](auto*, const CLIPRDR_FORMAT_DATA_RESPONSE* response) -> UINT {
      assert(response->common.msgFlags & CB_RESPONSE_OK);
      assert(response->common.dataLen == 4 + sizeof(FILEDESCRIPTORW));
      FILEDESCRIPTORW descriptor{};
      std::memcpy(&descriptor, response->requestedFormatData + 4, sizeof(descriptor));
      assert(std::wstring(descriptor.cFileName) == L"folder\\hello.txt");
      return 0;
    };
    CLIPRDR_FORMAT_DATA_REQUEST metadata{};
    metadata.requestedFormatId = adapter.clipboardFileDescriptorFormatId;
    assert(Impl::serverFormatDataRequest(&clip, &metadata) == 0);

    bool failed = false;
    clip.ClientFileContentsResponse = [](auto* c, const CLIPRDR_FILE_CONTENTS_RESPONSE* response) -> UINT {
      auto* flag = static_cast<bool*>(c->handle);
      *flag = (response->common.msgFlags & CB_RESPONSE_FAIL) != 0;
      return 0;
    };
    clip.handle = &failed;
    CLIPRDR_FILE_CONTENTS_REQUEST missing{};
    missing.dwFlags = FILECONTENTS_RANGE;
    missing.cbRequested = 5;
    assert(Impl::serverFileContentsRequest(&clip, &missing) == 0 && failed);

    // Real local bytes, including high-offset addressing and failure replies.
    const auto temp = std::filesystem::temp_directory_path() /
        ("ofs-cliprdr-" + std::to_string(GetCurrentProcessId()) + ".txt");
    { std::ofstream out(temp, std::ios::binary); out << "hello"; }
    adapter.clipboardFiles[0].path = temp.u8string();
    clip.ClientFileContentsResponse = [](auto*, const CLIPRDR_FILE_CONTENTS_RESPONSE* response) -> UINT {
      assert(response->common.msgFlags & CB_RESPONSE_OK);
      assert(response->cbRequested == 3);
      assert(std::string(reinterpret_cast<const char*>(response->requestedData), 3) == "llo");
      return 0;
    };
    missing.nPositionLow = 2;
    missing.cbRequested = 3;
    assert(Impl::serverFileContentsRequest(&clip, &missing) == 0);
    std::filesystem::remove(temp);

    adapter.remoteDescriptorId = 123;
    adapter.remoteGeneration = 9;
    clip.ClientFileContentsRequest = [](auto* c, const CLIPRDR_FILE_CONTENTS_REQUEST* request) -> UINT {
      const auto copy = *request;
      queued = [c, copy] {
        std::vector<BYTE> bytes;
        if (copy.dwFlags == FILECONTENTS_SIZE) {
          assert(copy.cbRequested == 8);
          bytes = {5,0,0,0,0,0,0,0};
        } else {
          assert(copy.nPositionHigh == 1 && copy.nPositionLow == 2);
          bytes = {'l','l','o'};
        }
        CLIPRDR_FILE_CONTENTS_RESPONSE response{};
        response.common.msgFlags = CB_RESPONSE_OK;
        response.streamId = copy.streamId;
        response.cbRequested = static_cast<UINT32>(bytes.size());
        response.requestedData = bytes.data();
        Impl::serverFileContentsResponse(c, &response);
      };
      return 0;
    };
    std::vector<BYTE> bytes;
    assert(adapter.readRemoteFile(9, 0, 0, 8, true, bytes) && bytes[0] == 5);
    assert(adapter.readRemoteFile(9, 0, (1ull << 32) + 2, 3, false, bytes));
    assert(std::string(bytes.begin(), bytes.end()) == "llo");
    assert(!adapter.readRemoteFile(8, 0, 0, 3, false, bytes));

    // The explicit download uses the same reader and preserves directories and
    // wire indices, including empty folders preceding regular files.
    const auto directory = std::filesystem::temp_directory_path() /
        ("ofs-cliprdr-dir-" + std::to_string(GetCurrentProcessId()));
    std::filesystem::remove_all(directory);
    assert(std::filesystem::create_directory(directory));
    adapter.remoteClipboardFiles = {{"folder", 0, true}, {"folder\\hello.txt", 5, false}, {"empty", 0, true}};
    clip.ClientFileContentsRequest = [](auto* c, const CLIPRDR_FILE_CONTENTS_REQUEST* request) -> UINT {
      const auto copy = *request;
      assert(copy.listIndex == 1);
      queued = [c, copy] {
        std::vector<BYTE> bytes = copy.dwFlags == FILECONTENTS_SIZE
            ? std::vector<BYTE>{5,0,0,0,0,0,0,0} : std::vector<BYTE>{'h','e','l','l','o'};
        CLIPRDR_FILE_CONTENTS_RESPONSE response{};
        response.common.msgFlags = CB_RESPONSE_OK;
        response.streamId = copy.streamId;
        response.cbRequested = static_cast<UINT32>(bytes.size());
        response.requestedData = bytes.data();
        Impl::serverFileContentsResponse(c, &response);
      };
      return 0;
    };
    Impl::Command download;
    download.kind = Impl::CommandKind::remoteFilesDownload;
    download.files.resize(1);
    download.text = directory.u8string();
    assert(adapter.execute(download));
    assert(std::filesystem::is_directory(directory / "empty"));
    { std::ifstream input(directory / "folder" / "hello.txt");
      std::string content; input >> content; assert(content == "hello"); }
    // Existing destinations are preserved, not silently overwritten.
    assert(!adapter.execute(download));
    assert(!adapter.remoteDownloadActive);
    std::filesystem::remove_all(directory);

    // An empty successful response before EOF must fail, not spin forever.
    clip.ClientFileContentsRequest = [](auto* c, const CLIPRDR_FILE_CONTENTS_REQUEST* request) -> UINT {
      const auto id = request->streamId;
      queued = [c, id] {
        CLIPRDR_FILE_CONTENTS_RESPONSE response{};
        response.common.msgFlags = CB_RESPONSE_OK;
        response.streamId = id;
        Impl::serverFileContentsResponse(c, &response);
      };
      return 0;
    };
    assert(!adapter.readRemoteFile(9, 0, 0, 3, false, bytes));
    // A new selection during a read invalidates the old stream.
    clip.ClientFileContentsRequest = [](auto* c, const CLIPRDR_FILE_CONTENTS_REQUEST*) -> UINT {
      queued = [c] { ++static_cast<Impl*>(c->custom)->remoteGeneration; };
      return 0;
    };
    assert(!adapter.readRemoteFile(9, 0, 0, 3, false, bytes));
    adapter.stopping = true;
    assert(!adapter.readRemoteFile(10, 0, 0, 3, false, bytes));
  }
};

int main() { FreeRdpAdapterTestPeer::run(); }
