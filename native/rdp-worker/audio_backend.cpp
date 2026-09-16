#include "audio_backend.h"
#include <cstdint>
#include <cstring>
#include <mutex>
#include <unordered_map>
#if !defined(_WIN32)
#include <dlfcn.h>
#include <filesystem>
#include <limits.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#endif
#if OFS_RDP_HAS_FREERDP
#include <freerdp/addin.h>
#include <freerdp/channels/channels.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/rdpsnd.h>
#include <winpr/wlog.h>

namespace ofs::rdp {
namespace {
std::mutex mutex;
std::function<void(bool)> onOpen;
struct DeviceHooks { pcOpen open; pcFree free; };
std::unordered_map<rdpsndDevicePlugin*, DeviceHooks> devices;
// FreeRDP calls the returned entry immediately on the same loading thread.
// Static and dynamic sound channels can initialize on different threads.
thread_local PREGISTERRDPSNDDEVICE registerDevice = nullptr;
thread_local PFREERDP_RDPSND_DEVICE_ENTRY nextEntry = nullptr;

PVIRTUALCHANNELENTRY load(const char* name, const char* subsystem, const char* type, DWORD flags) {
  auto entry = freerdp_channels_load_static_addin_entry(name, subsystem, type, flags);
#if !defined(_WIN32)
  if (!entry && name && subsystem && std::strcmp(name, "rdpsnd") == 0) {
    char executable[PATH_MAX]{};
#if defined(__APPLE__)
    std::uint32_t length = sizeof(executable);
    const bool located = _NSGetExecutablePath(executable, &length) == 0;
    const char* extension = ".dylib";
#else
    const auto length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    const bool located = length > 0;
    const char* extension = ".so";
#endif
    if (located) {
      for (const auto* prefix : {"lib", ""}) {
        const auto path = std::filesystem::path(executable).parent_path() /
            (std::string(prefix) + "rdpsnd-client-" + subsystem + extension);
        if (void* library = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL)) {
          entry = reinterpret_cast<PVIRTUALCHANNELENTRY>(dlsym(library, RDPSND_DEVICE_EXPORT_FUNC_NAME));
          if (entry) break; // device callbacks require this module until process exit
          dlclose(library);
        }
      }
    }
  }
#endif
  if (!entry) entry = freerdp_load_dynamic_channel_addin_entry(name, subsystem, type, flags);
  return entry;
}
void notify(bool opened) {
  std::function<void(bool)> callback;
  { std::lock_guard<std::mutex> guard(mutex); callback = onOpen; }
  if (callback) callback(opened);
}
// The constness of AUDIO_FORMAT changed between SDK releases. Derive the
// wrapper signature from the installed SDK instead of assuming its ABI.
template<typename T> struct OpenHook;
template<typename Result, typename Device, typename Format, typename Latency>
struct OpenHook<Result (*)(Device, Format, Latency)> {
  static Result call(Device device, Format format, Latency latency) {
    pcOpen original = nullptr;
    { std::lock_guard<std::mutex> guard(mutex); const auto it = devices.find(device); if (it != devices.end()) original = it->second.open; }
    const auto result = original ? original(device, format, latency) : FALSE;
    notify(result != FALSE);
    return result;
  }
};
void freeDevice(rdpsndDevicePlugin* device) {
  pcFree original = nullptr;
  { std::lock_guard<std::mutex> guard(mutex); const auto it = devices.find(device); if (it != devices.end()) { original = it->second.free; devices.erase(it); } }
  if (original) original(device);
}
void interceptDevice(rdpsndPlugin* plugin, rdpsndDevicePlugin* device) {
  if (!device || !registerDevice) return;
  { std::lock_guard<std::mutex> guard(mutex); devices[device] = {device->Open, device->Free}; }
  device->Open = &OpenHook<pcOpen>::call;
  device->Free = freeDevice;
  registerDevice(plugin, device);
}
UINT VCAPITYPE enterDevice(PFREERDP_RDPSND_DEVICE_ENTRY_POINTS points) {
  if (!points || !nextEntry) return 1;
  auto forwarded = *points;
  registerDevice = points->pRegisterRdpsndDevice;
  forwarded.pRegisterRdpsndDevice = interceptDevice;
  const auto result = nextEntry(&forwarded);
  if (result) notify(false);
  return result;
}
UINT VCAPITYPE rejectFakeDevice(PFREERDP_RDPSND_DEVICE_ENTRY_POINTS) {
  notify(false);
  return 1;
}
PVIRTUALCHANNELENTRY provider(LPCSTR name, LPCSTR subsystem, LPCSTR type, DWORD flags) {
  // The fake backend consumes audio without playing it; never let fallback
  // through that backend turn a missing device into a success indication.
  // Return an explicit rejecting entry; nullptr would let FreeRDP fall back
  // to its dynamic loader and bypass this provider's fake-device rejection.
  if (name && subsystem && std::strcmp(name, "rdpsnd") == 0 && std::strcmp(subsystem, "fake") == 0)
    return reinterpret_cast<PVIRTUALCHANNELENTRY>(&rejectFakeDevice);
  const auto entry = load(name, subsystem, type, flags);
  if (entry && name && subsystem && std::strcmp(name, "rdpsnd") == 0) {
    nextEntry = reinterpret_cast<PFREERDP_RDPSND_DEVICE_ENTRY>(entry);
    return reinterpret_cast<PVIRTUALCHANNELENTRY>(&enterDevice);
  }
  return entry;
}
}
bool audioBackendAvailable() {
  // stdout is reserved for OFSR frames, including during the HELLO probe.
  if (auto* root = WLog_GetRoot()) WLog_SetLogLevel(root, WLOG_OFF);
#if defined(_WIN32)
  const char* names[] = {"winmm"};
#elif defined(__APPLE__)
  const char* names[] = {"mac"};
#else
  const char* names[] = {"pulse", "alsa"};
#endif
  for (const auto* name : names)
    if (load("rdpsnd", name, nullptr, FREERDP_ADDIN_CHANNEL_STATIC | FREERDP_ADDIN_CHANNEL_ENTRYEX)) return true;
  return false;
}
bool registerAudioBackend(std::function<void(bool)> opened) {
  { std::lock_guard<std::mutex> guard(mutex); onOpen = std::move(opened); }
  return freerdp_register_addin_provider(provider, 0) == 0;
}
void clearAudioBackend() { std::lock_guard<std::mutex> guard(mutex); onOpen = {}; }
}
#else
namespace ofs::rdp {
bool audioBackendAvailable() { return false; }
bool registerAudioBackend(std::function<void(bool)>) { return false; }
void clearAudioBackend() {}
}
#endif
