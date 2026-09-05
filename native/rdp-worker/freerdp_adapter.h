#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// The adapter is compiled into the worker only when CMake found a FreeRDP SDK.
// Keeping the public surface FreeRDP-free makes the protocol/mock build useful
// on machines that do not have the native SDK installed.
class FreeRdpAdapter {
 public:
  struct Display {
    std::uint32_t width = 1280;
    std::uint32_t height = 720;
    std::uint32_t dpi = 96;
  };

  struct Config {
    std::string host;
    std::uint16_t port = 3389;
    std::string username;
    std::string domain;
    Display display;
    bool clipboard = false;
    std::string certificatePolicy = "prompt";
  };

  struct Rect {
    std::int32_t x = 0;
    std::int32_t y = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::uint32_t stride = 0;
    std::vector<std::uint8_t> pixels;
  };

  using StateCallback = std::function<void(const char* state, const char* errorCode)>;
  using PromptCallback = std::function<void(std::uint32_t requestId, const char* host,
                                             std::uint16_t port, const char* subject,
                                             const char* issuer, const char* fingerprint,
                                             bool changed)>;
  using FrameCallback = std::function<void(std::uint32_t width, std::uint32_t height,
                                           std::uint32_t sequence, std::vector<Rect> rects)>;
  using ClipboardCallback = std::function<void(std::uint32_t requestId, std::string text)>;

  FreeRdpAdapter();
  ~FreeRdpAdapter();

  FreeRdpAdapter(const FreeRdpAdapter&) = delete;
  FreeRdpAdapter& operator=(const FreeRdpAdapter&) = delete;

  bool start(Config config, StateCallback state, PromptCallback prompt, FrameCallback frame,
             ClipboardCallback clipboard);
  bool providePassword(std::string_view password);
  bool provideCertificate(std::uint32_t requestId, bool accept);
  bool resize(Display display);
  bool key(std::uint32_t scanCode, bool pressed, bool extended,
           std::optional<std::uint32_t> unicode = std::nullopt);
  bool pointer(std::uint32_t x, std::uint32_t y, std::uint32_t buttons,
               std::int32_t wheelX, std::int32_t wheelY);
  bool clipboardSet(std::string_view text);
  bool clipboardGet(std::uint32_t requestId);
  void close();

 private:
  struct Impl;
  Impl* impl_ = nullptr;
};
