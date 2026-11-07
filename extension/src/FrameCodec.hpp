// FrameCodec.hpp — length-prefixed framing, independent of any transport.
//
// Wire format (see Protocol.hpp): [uint32 LE length][payload bytes].
// Split out from IpcClient so it can be unit-tested without sockets/pipes.

#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace ahc {

std::string EncodeFrame(const std::string& payload);

class FrameDecoder {
public:
    bool Feed(const char* data, std::size_t len,
              const std::function<void(const std::string&)>& onFrame);

    void Reset() { buf_.clear(); }

private:
    std::string buf_;
};

} // namespace ahc
