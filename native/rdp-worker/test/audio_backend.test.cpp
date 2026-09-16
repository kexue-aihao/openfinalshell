#include <freerdp/addin.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/rdpsnd.h>
#include <cassert>

static FREERDP_LOAD_CHANNEL_ADDIN_ENTRY_FN installed = nullptr;
static rdpsndDevicePlugin device{};
static bool openResult = true;
static unsigned frees = 0, registrations = 0, dynamicLoads = 0;
template<typename Signature> struct TestOpen;
template<typename Result, typename Device, typename Format, typename Latency>
struct TestOpen<Result (*)(Device, Format, Latency)> {
  static Result call(Device, Format, Latency) { return openResult ? TRUE : FALSE; }
};
static void testFree(rdpsndDevicePlugin*) { ++frees; }
static UINT VCAPITYPE testDeviceEntry(PFREERDP_RDPSND_DEVICE_ENTRY_POINTS points) {
  device = {};
  device.Open = &TestOpen<pcOpen>::call;
  device.Free = testFree;
  points->pRegisterRdpsndDevice(points->rdpsnd, &device);
  return 0;
}
static PVIRTUALCHANNELENTRY testStatic(LPCSTR, LPCSTR, LPCSTR, DWORD) {
  return reinterpret_cast<PVIRTUALCHANNELENTRY>(&testDeviceEntry);
}
static PVIRTUALCHANNELENTRY testDynamic(LPCSTR, LPCSTR, LPCSTR, DWORD) {
  ++dynamicLoads; return nullptr;
}
static int testRegister(FREERDP_LOAD_CHANNEL_ADDIN_ENTRY_FN provider, DWORD) { installed = provider; return 0; }
#define freerdp_channels_load_static_addin_entry testStatic
#define freerdp_load_dynamic_channel_addin_entry testDynamic
#define freerdp_register_addin_provider testRegister
#include "../audio_backend.cpp"
#undef freerdp_channels_load_static_addin_entry
#undef freerdp_load_dynamic_channel_addin_entry
#undef freerdp_register_addin_provider

int main() {
  unsigned events = 0;
  bool reported = false;
  assert(ofs::rdp::audioBackendAvailable());
  assert(ofs::rdp::registerAudioBackend([&](bool opened) { ++events; reported = opened; }));
  FREERDP_RDPSND_DEVICE_ENTRY_POINTS points{};
  points.pRegisterRdpsndDevice = [](rdpsndPlugin*, rdpsndDevicePlugin* next) { assert(next == &device); ++registrations; };
  auto entry = reinterpret_cast<PFREERDP_RDPSND_DEVICE_ENTRY>(installed("rdpsnd", "winmm", nullptr, 0));
  assert(entry && entry(&points) == 0 && registrations == 1);
  assert(events == 0); // module registration alone is not playback success
  assert(device.Open(&device, nullptr, 0) && events == 1 && reported);
  openResult = false;
  assert(!device.Open(&device, nullptr, 0) && events == 2 && !reported);
  auto fake = reinterpret_cast<PFREERDP_RDPSND_DEVICE_ENTRY>(installed("rdpsnd", "fake", nullptr, 0));
  assert(fake && fake(&points) != 0 && dynamicLoads == 0 && !reported);
  ofs::rdp::clearAudioBackend();
  const auto prior = events;
  openResult = true;
  assert(device.Open(&device, nullptr, 0) && events == prior);
  device.Free(&device);
  assert(frees == 1);
}
