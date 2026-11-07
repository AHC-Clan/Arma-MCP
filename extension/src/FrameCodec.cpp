#include "FrameCodec.hpp"

#include "Protocol.hpp"

namespace ahc {

std::string EncodeFrame(const std::string& payload) {
    const auto n = static_cast<std::uint32_t>(payload.size());
    std::string frame;
    frame.reserve(4 + payload.size());
    frame.push_back(static_cast<char>(n & 0xFF));
    frame.push_back(static_cast<char>((n >> 8) & 0xFF));
    frame.push_back(static_cast<char>((n >> 16) & 0xFF));
    frame.push_back(static_cast<char>((n >> 24) & 0xFF));
    frame.append(payload);
    return frame;
}

bool FrameDecoder::Feed(const char* data, std::size_t len,
                        const std::function<void(const std::string&)>& onFrame) {
    buf_.append(data, len);

    for (;;) {
        if (buf_.size() < 4) return true;

        const std::uint32_t n =
            (static_cast<std::uint32_t>(static_cast<unsigned char>(buf_[0]))) |
            (static_cast<std::uint32_t>(static_cast<unsigned char>(buf_[1])) << 8) |
            (static_cast<std::uint32_t>(static_cast<unsigned char>(buf_[2])) << 16) |
            (static_cast<std::uint32_t>(static_cast<unsigned char>(buf_[3])) << 24);

        if (n > kMaxFrameBytes) return false;

        if (buf_.size() < 4u + n) return true;

        onFrame(buf_.substr(4, n));
        buf_.erase(0, 4u + n);
    }
}

} // namespace ahc
