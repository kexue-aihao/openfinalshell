#pragma once
#include <functional>
namespace ofs::rdp {
// Available means at least one real rdpsnd device plugin was found. Actual
// device opening is reported separately when the server negotiates a format.
bool audioBackendAvailable();
bool registerAudioBackend(std::function<void(bool)> opened);
void clearAudioBackend();
}
