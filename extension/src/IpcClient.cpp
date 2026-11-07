#include "IpcClient.hpp"

#include <utility>

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  pragma comment(lib, "ws2_32.lib")
#endif

namespace ahc {

#if defined(_WIN32)

struct IpcClient::Impl {
    enum class Kind { None, Pipe, Tcp } kind = Kind::None;
    HANDLE pipe = INVALID_HANDLE_VALUE;
    SOCKET sock = INVALID_SOCKET;
    bool wsaStarted = false;

    void closeAll() {
        if (pipe != INVALID_HANDLE_VALUE) {
            CloseHandle(pipe);
            pipe = INVALID_HANDLE_VALUE;
        }
        if (sock != INVALID_SOCKET) {
            closesocket(sock);
            sock = INVALID_SOCKET;
        }
        kind = Kind::None;
    }
};

IpcClient::IpcClient() : impl_(new Impl()) {}

IpcClient::~IpcClient() {
    Disconnect();
    if (impl_->wsaStarted) WSACleanup();
    delete impl_;
}

bool IpcClient::ConnectPipe(const std::string& pipeName) {
    Disconnect();
    decoder_.Reset();

    if (!WaitNamedPipeA(pipeName.c_str(), 1000)) {
        return false;
    }
    HANDLE h = CreateFileA(pipeName.c_str(), GENERIC_READ | GENERIC_WRITE,
                           0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;

    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(h, &mode, nullptr, nullptr);

    impl_->pipe = h;
    impl_->kind = Impl::Kind::Pipe;
    return true;
}

bool IpcClient::ConnectTcp(const std::string& host, std::uint16_t port) {
    Disconnect();
    decoder_.Reset();

    if (!impl_->wsaStarted) {
        WSADATA wsa;
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
        impl_->wsaStarted = true;
    }

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
        closesocket(s);
        return false;
    }
    if (connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == SOCKET_ERROR) {
        closesocket(s);
        return false;
    }

    u_long nonblock = 1;
    ioctlsocket(s, FIONBIO, &nonblock);

    impl_->sock = s;
    impl_->kind = Impl::Kind::Tcp;
    return true;
}

bool IpcClient::IsConnected() const {
    return impl_->kind != Impl::Kind::None;
}

bool IpcClient::SendFrame(const std::string& payload) {
    if (!IsConnected()) return false;
    const std::string frame = EncodeFrame(payload);

    std::size_t off = 0;
    while (off < frame.size()) {
        if (impl_->kind == Impl::Kind::Pipe) {
            DWORD wrote = 0;
            if (!WriteFile(impl_->pipe, frame.data() + off,
                           static_cast<DWORD>(frame.size() - off), &wrote, nullptr)) {
                return false;
            }
            off += wrote;
        } else {
            const int sent = send(impl_->sock, frame.data() + off,
                                  static_cast<int>(frame.size() - off), 0);
            if (sent == SOCKET_ERROR) {
                const int err = WSAGetLastError();
                if (err == WSAEWOULDBLOCK) {
                    // 논블로킹 소켓 백프레셔 — busy-spin 하지 말고 쓰기 가능까지
                    // select 로 최대 50ms 대기(워커 스레드라 sim 은 안 막힌다).
                    fd_set wfds;
                    FD_ZERO(&wfds);
                    FD_SET(impl_->sock, &wfds);
                    timeval tv{0, 50 * 1000};
                    const int rc = select(0, nullptr, &wfds, nullptr, &tv);
                    if (rc == SOCKET_ERROR) return false;
                    continue;
                }
                return false;
            }
            off += static_cast<std::size_t>(sent);
        }
    }
    return true;
}

bool IpcClient::PumpReads() {
    if (!IsConnected()) return false;
    char chunk[4096];

    if (impl_->kind == Impl::Kind::Pipe) {
        DWORD avail = 0;
        if (!PeekNamedPipe(impl_->pipe, nullptr, 0, nullptr, &avail, nullptr)) {
            return false;
        }
        while (avail > 0) {
            DWORD got = 0;
            const DWORD want = avail < sizeof(chunk) ? avail : static_cast<DWORD>(sizeof(chunk));
            if (!ReadFile(impl_->pipe, chunk, want, &got, nullptr) || got == 0) {
                return false;
            }
            if (!decoder_.Feed(chunk, got, frameHandler_)) return false;
            avail -= got;
        }
        return true;
    }

    for (;;) {
        const int got = recv(impl_->sock, chunk, sizeof(chunk), 0);
        if (got > 0) {
            if (!decoder_.Feed(chunk, static_cast<std::size_t>(got), frameHandler_)) return false;
            continue;
        }
        if (got == 0) return false;
        const int err = WSAGetLastError();
        if (err == WSAEWOULDBLOCK) return true;
        return false;
    }
}

void IpcClient::SetFrameHandler(std::function<void(const std::string&)> handler) {
    frameHandler_ = std::move(handler);
}

void IpcClient::Disconnect() {
    impl_->closeAll();
}

#else  // non-Windows: stub so the framing/queue unit tests still build on CI/dev boxes.

struct IpcClient::Impl {};
IpcClient::IpcClient() : impl_(new Impl()) {}
IpcClient::~IpcClient() { delete impl_; }
bool IpcClient::ConnectPipe(const std::string&) { return false; }
bool IpcClient::ConnectTcp(const std::string&, std::uint16_t) { return false; }
bool IpcClient::IsConnected() const { return false; }
bool IpcClient::SendFrame(const std::string&) { return false; }
bool IpcClient::PumpReads() { return false; }
void IpcClient::SetFrameHandler(std::function<void(const std::string&)> handler) { frameHandler_ = std::move(handler); }
void IpcClient::Disconnect() {}

#endif

} // namespace ahc
