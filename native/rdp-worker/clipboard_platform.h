#pragma once
#include "file_clipboard.h"

namespace ofs::rdp {
// Platform operations execute on the platform runloop. The returned sequence
// is an ownership token: clear only when it still belongs to this publication.
std::uint32_t publishLocalFileUrls(const std::vector<std::string>& paths,
                                 std::uint32_t expectedSequence,
                                 const std::function<bool()>& valid);
void clearOwnedLocalClipboard(std::uint32_t sequence);
bool ownsLocalFileClipboard(std::uint32_t sequence);
}
