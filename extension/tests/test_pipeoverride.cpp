// test_pipeoverride.cpp — ARMA_MCP_GAME_PIPE override rules and the hello frame.
//
// The daemon sets ARMA_MCP_GAME_PIPE on the games it launches so each test stack's
// games reach that stack's own pipe. A game started by hand has no such value and
// keeps the pipe name SQF passes.
#include "../src/Bridge.hpp"

#include <cstdio>
#include <string>

using namespace ahc;

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failures; } } while (0)

int main() {
    const std::string sqf = R"(\\.\pipe\arma_mcp)";

    // 1) Unset: SQF name.
    CHECK(Bridge::ResolvePipeName(sqf, nullptr) == sqf);

    // 2) A valid pipe wins, including a different case prefix.
    CHECK(Bridge::ResolvePipeName(sqf, R"(\\.\pipe\arma_mcp_s_b)") == R"(\\.\pipe\arma_mcp_s_b)");
    CHECK(Bridge::ResolvePipeName(sqf, R"(\\.\PIPE\arma_mcp_s_b)") == R"(\\.\PIPE\arma_mcp_s_b)");

    // 3) Not a local pipe: ignored.
    CHECK(Bridge::ResolvePipeName(sqf, "arma_mcp_s_b") == sqf);
    CHECK(Bridge::ResolvePipeName(sqf, R"(\\server\pipe\arma_mcp)") == sqf);
    CHECK(Bridge::ResolvePipeName(sqf, "") == sqf);

    // 4) The bare prefix with no name: ignored.
    CHECK(Bridge::ResolvePipeName(sqf, R"(\\.\pipe\)") == sqf);

    // 5) Too long or with control characters: ignored.
    {
        std::string longName = R"(\\.\pipe\)";
        longName.append(Bridge::kMaxPipeNameLen, 'x');
        CHECK(Bridge::ResolvePipeName(sqf, longName.c_str()) == sqf);
        const std::string edge = std::string(R"(\\.\pipe\)") +
                                 std::string(Bridge::kMaxPipeNameLen - 9, 'y');
        CHECK(edge.size() == Bridge::kMaxPipeNameLen);
        CHECK(Bridge::ResolvePipeName(sqf, edge.c_str()) == edge);
        CHECK(Bridge::ResolvePipeName(sqf, "\\\\.\\pipe\\a\tb") == sqf);
    }

    // 6) hello carries the version and the pid.
    CHECK(Bridge::BuildHello("ArmaMCP 1.2.3", 4242) ==
          R"({"v":1,"type":"hello","role":"arma-ext","ver":"ArmaMCP 1.2.3","pid":4242})");

    if (g_failures == 0) {
        std::printf("test_pipeoverride: ALL PASS\n");
        return 0;
    }
    std::printf("test_pipeoverride: %d FAILURE(S)\n", g_failures);
    return 1;
}
