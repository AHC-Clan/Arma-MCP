# Arma-MCP Repository Guidance

## Architecture and ownership

- `server/` is the Node.js/TypeScript MCP host. One long-running daemon owns the pipe/TCP gateway and shared launch/RPT/web/capture services. Host plugins run thin stdio relays, and each relay receives an independent HTTP MCP session.
- `extension/` is the C++17 Arma extension DLL and named-pipe/TCP client. Keep the canonical dual-bitness outputs: `arma_mcp_x64.dll` and `arma_mcp.dll`.
- `addon/` is the SQF in-game bridge. CBA and ACE are optional capabilities; the addon must continue to load without CBA. It also adds the main menu "Connect AI Agent" row and window, which is how other people connect.
- `build/` contains Windows build, test, and deploy entrypoints. `docs/` defines the tool, protocol, and real-game verification contracts.
- `README.md` holds only what the project is, how to start, what to say, and links to `docs/`. Technical content belongs in `docs/`. It is written for people who are not developers.
- Public files stay free of anything specific to one group's deployment. Maintainer notes, when present, are in `docs/internal/`: read them before deploying anywhere. `build\publish-github.ps1` leaves that folder and the deployment scripts out of the public tree.
- `server/bundle/index.mjs` is the committed distribution artifact used by both host adapters and by the `bin/arma-mcp` CLI shim. Regenerate it after any relevant `server/src` change.
- `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` are thin host-specific adapters to that shared bundle. `.claude-plugin/marketplace.json` is the single legacy-compatible marketplace; do not add a duplicate `.agents/plugins/marketplace.json`.
- `hooks/hooks.json` and `server/src/selfupdate/hosts.ts` are the self-update host adapters, and `extension/src/HostConnect.*` is the main menu host adapter, because the mod carries no Node program. They are the only places where host names, host CLI commands, and installation layouts belong; the rest of `server/src/selfupdate` receives them as `--root`/`--cli` arguments and through the `HostAdapter` interface.

## Shared contracts

- Stdout belongs to whatever transport owns the running mode: MCP framing in `relay`/`standalone`, one line of hook JSON in `selfupdate hook`, human report text in `doctor` and `selfupdate check`, command results in `cli`, with human error lines on stderr. Nothing else may write to stdout, and diagnostics go to stderr through the shared logger in every mode.
- Keep shared source, tests, and prose host-neutral: prefer “MCP client”, “agent”, “plugin root”, and “client session”. Host names and root variables belong only in installation instructions and host adapters.
- Preserve protocol v1 framing and the coordinated TS producer/consumer, C++ bridge, SQF routing, documentation, and loopback tests when changing wire behavior.
- The operating daemon must own the game pipe exclusively and fail startup on `EADDRINUSE`. Additional Claude/Codex sessions connect through the daemon HTTP endpoint and must never open another game gateway.
- Test stacks share that daemon. The default stack keeps the configured game pipe, port, and paths, so calls without a stack behave as in 0.4. A named stack `<id>` uses its own pipe `<pipeName>_s_<id>`, which the same daemon opens; `EADDRINUSE` on a stack pipe fails only that stack. The daemon passes the stack pipe to the games it launches through `ARMA_MCP_GAME_PIPE`, and a game belongs to a stack by the `-profiles` path under `stacks.root`. Stack kills stop only that stack's pids.
- Every game the daemon launches runs without BattlEye. The server reads only the generated `server.cfg`, which holds the single `BattlEye = 0;`, and clients start the game exe directly, never through a BattlEye launcher. When a launch starts more than one client, each client gets its own `-profiles` folder and `-name`, and the server opens in LAN mode (`loopback = true;`) so clients sharing one Steam ID pass the Steam ticket check.
- A relay may start the daemon when nothing is listening on the MCP port, and may restart an older daemon after an upgrade, but it never opens a game gateway itself. Exclusivity stays with pipe and port ownership: a duplicate daemon must exit. Keep `ARMA_MCP_NO_AUTOSTART` and `ARMA_MCP_TOKEN` as autostart suppressors so a tunneled remote session never spawns a local daemon.
- The only process a relay may kill is the old daemon it is upgrading, and only after that daemon acknowledged `/shutdown` and then failed to exit. Pick it before `/shutdown` from the health `pid` or the MCP port owner, and require a node command line that runs an arma-mcp bundle `index.mjs` with the mode argument `daemon`. Re-read the process list right before the kill and skip it when that pid no longer shows the same command line. Never pick the relay itself, other modes, or daemons found by command line alone.
- The CLI (`cli` mode, `docs/cli.md`) only connects to a running daemon as a `cli` session. It never starts, restarts, or stops a daemon, and it never opens a game gateway. `bin/arma-mcp` stays an LF shell shim committed with the executable bit (mode 100755).
- The main menu connect commands (`docs/protocol.md`) run host CLIs from the DLL, so they stay gated in C++ on the engine call context: only `fn_connect*.sqf` on the main menu, never in a mission or on a server. Every command line argument is a constant, and nothing from SQF reaches one. They never start a daemon, never touch the game pipe, and never edit a marketplace registration that already exists. Main menu SQF runs on display events, not `spawn`.
- `web.host` defaults to loopback, so a first run shows no firewall prompt. LAN publishing is an explicit setting.
- Keep the administrator MCP endpoint bound to loopback with bearer, Host, and Origin checks. Remote access is through an SSH/VPN tunnel, never a plain LAN/public bind.
- Preserve SQF comment stripping/rejection before `compile`. Treat an unexpected `<nil>` as ambiguous and use the attached RPT error block as the source of truth.
- Keep CBA optional: do not add `cba_main` to `requiredAddons`. `A3_Ui_F` stays there so the main menu classes exist when the addon extends them.
- A version bump must update the Claude and Codex manifests, marketplace entry, server package/MCP metadata, addon metadata, DLL version, bridge hello string, and matching protocol examples together.
- The public marketplace is `https://github.com/AHC-Clan/Arma-MCP.git`, and `kMarketplaceUrl` in `extension/src/HostConnect.hpp` and the manifests must match it. That repository has its own history: publish with `build\publish-github.ps1`, which adds one commit holding the committed tree. Never push this repository's branches to it, and keep private hosts and credentials out of the tree.
- A release must be a version-bump commit. Session-start self-update decides solely by comparing the marketplace entry's `version` against the installed version, so a commit that does not raise the version reaches no user. Keep `ARMA_MCP_NO_AUTOUPDATE` and `ARMA_MCP_TOKEN` as self-update suppressors, and never let self-update rewrite a user's marketplace registration — a manifest that could redirect its own source would make one bad release self-propagating.

## Local files and safety

- Never commit `.mcp.json`, `.claude/settings.local.json`, or `arma-mcp.config.json`; they contain machine-specific paths or permissions. Keep examples generic.
- Do not overwrite unrelated working-tree changes or untracked editor settings.
- Build without deployment by default. Do not write to a Steam Workshop copy or any other external mod directory unless the user explicitly requests deployment.
- `build\package-release.ps1` assembles `dist\release\@AHC_ArmaMCP` (repo-local, gitignored), which is the mod folder.

## Build and verification

Run commands from the repository root on Windows PowerShell.

### TypeScript server

```powershell
cmd /c npm --prefix server ci
cmd /c npm --prefix server run build
cmd /c npm --prefix server test
cmd /c npm --prefix server run smoke
cmd /c npm --prefix server run bundle
```

- `run smoke` creates an isolated config and temporary missions under the OS temp directory, then removes them.
- After bundling, verify that `server/bundle/index.mjs` is updated and included with the source change.

### C++ extension and SQF addon

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build\test-cpp.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File build\build-extension.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File build\build-pbo.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File build\build-all.ps1
```

- `test-cpp.ps1` is the canonical C++ unit and DLL-to-Node loopback check.
- Use `build-extension.ps1` for the canonical x64+x86 DLL build.
- Use `build-pbo.ps1` for addon changes; it uses the repo-local HEMTT when available.

### Validation by change area

- `server/src`: TypeScript build, unit tests, smoke test, then regenerate the bundle.
- `server/src/cli`: the same checks, plus the smoke daemon phase, which drives the CLI against an isolated daemon, port, pipe, and token file. Update `docs/cli.md` when a command, flag, output, or exit code changes.
- `extension`: C++ tests and dual-bitness build.
- `addon`: PBO build and preservation of the standalone-without-CBA contract.
- Protocol or cross-layer behavior: server tests, C++ loopback, affected SQF checks, and `docs/protocol.md`.
- Plugin metadata or entrypoints: validate both manifests, confirm their name/version/bundle target agree, and verify the marketplace still resolves the repository-root plugin.
- Real-game behavior: follow the relevant scenario in `docs/testing.md`; do not substitute browser or MCP visibility alone for RPT/game evidence.
