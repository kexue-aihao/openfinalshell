#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>

namespace ofs::rdp {

struct RdpFileEntry {
  std::string relativePath;
  std::uint64_t size = 0;
  bool directory = false;
};

bool safeRelativePath(std::string_view path);
bool safeLocalFile(const std::filesystem::path& path, std::uint64_t& size, bool& directory);
bool readFileChunk(const std::filesystem::path& path, std::uint64_t offset,
                   std::uint32_t count, std::string& output);

} // namespace ofs::rdp
