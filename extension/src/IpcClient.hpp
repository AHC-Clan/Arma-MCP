// IpcClient.hpp — Windows named-pipe / loopback-TCP client used by the worker.
//
// The Arma-MCP server is the SERVER (long-lived); the DLL is the CLIENT and
// connects when a mission loads. Framing is delegated to FrameCodec. All calls
// here are made from the Bridge worker thread only.

#pragma once

#include <cstdint>
#include <functional>
#include <string>

#include "FrameCodec.hpp"

namespace ahc {

class IpcClient {
public:
    IpcClient();
    ~IpcClient();

    IpcClient(const IpcClient&) = delete;
    IpcClient& operator=(const IpcClient&) = delete;

    bool ConnectPipe(const std::string& pipeName);
    bool ConnectTcp(const std::string& host, std::uint16_t port);
    bool IsConnected() const;
    bool SendFrame(const std::string& payload);
    bool PumpReads();
    void SetFrameHandler(std::function<void(const std::string&)> handler);
    void Disconnect();

private:
    struct Impl;
    Impl* impl_;
    FrameDecoder decoder_;
    std::function<void(const std::string&)> frameHandler_;
};

} // namespace ahc
