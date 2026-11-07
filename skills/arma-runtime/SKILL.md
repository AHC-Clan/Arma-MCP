---
name: arma-runtime
description: Use when a task requires operating or diagnosing a live Arma 3 runtime through Arma-MCP, including game or bridge status, a requested launch, SQF execution or waits, mission state, Zeus names and modules, RPT inspection, capture, and real-game testing. Do not use for source-only code, documentation, review, or build tasks that do not need a live game.
---

# Arma runtime

Use the shared Arma-MCP runtime deliberately and collect evidence from the game when the task needs it.

If the MCP client loads tool schemas on demand, load the arma tool schemas you expect to need in one batch rather than one at a time.

## Route live-runtime work

1. Call `arma_status` first unless fresh status is already available in the current context.
2. Start a runtime only when the user requested live execution or testing. Use `arma_play` for the normal test flow and the relevant `arma_launch*` tool for an explicit launch mode.
   If `arma_status` shows another session's game or lease on the default stack, pick your own `stack` name and pass it to every call. A named stack has its own server, clients, port, RPT folders, and launch lease, and `arma_kill` stops only that stack's games. For a dedicated server with several local clients, use `arma_play` with `mode:'mp'` and `clients`.
3. For a repeated test cycle, run `arma_play` once with `saveProfile`, then relaunch with only `profile`. Add `ready` to wait for a marker line in the RPT of this launch. Add `then` to run setup SQF in the same call. End the setup code with a value such as `; true`, because a `<nil>` result also fails on unrelated RPT error blocks. `arma_status` lists the saved profile names.
4. Before rebuilding a PBO or DLL that the running game has loaded, call `arma_kill` with `unlockPaths`. It waits until the processes are gone and the files are writable. Do not add a manual wait loop.
   Never rebuild a base mod folder that another stack loads. Pass only the newly built PBOs or build output as `testMods`. The game loads a copy in the stack folder, so the build output stays writable while the game runs, and a PBO that replaces one in a base mod hides the original.
5. Use `arma_mission_info` to inspect mission state.
6. When the user names a target by what Zeus shows (a unit type, player name, group callsign, vehicle, module, marker, editor variable) or by what they selected in Zeus, call `arma_zeus_find` before `arma_exec`, then put the returned `sqf` expression into the exec code. Use `source:'palette'` for Zeus spawn list names. Several matches are ambiguous: pick by `dist` or `grid`, or ask the user. Use `arma_zeus_module` only when the user asks to run a Zeus module, and report `outcome` as it came back.
7. Use `arma_exec` with `verify` for SQF changes or queries. SQF requires an active mission bridge. When the result must be seen on screen, pass `capture` to get the screenshot in the same call instead of a separate `arma_capture`.
8. Use `arma_watch` for conditions that must become true in game instead of repeatedly polling by hand.
9. Use `arma_rpt_*` and `arma_capture` to gather runtime evidence appropriate to the claim being verified.

When a launch, play, kill, or scaffold call returns `busy`, another operation holds the runtime. `busy.owner` names the session that holds it. `busy.mine` is true when that is an earlier call from your own session.

Do not launch or mutate the game for source-only work. Broadcast tools affect players, so call them only for an explicit request to show something in game; never use them for acknowledgements, progress, reports, or answers.

For real-game test scenarios and required evidence, follow [the testing contract](../../docs/testing.md). For advanced tactical-map routing and function conventions, follow [the TacMap guide](../../docs/tacmap.md).

## Chain from the shell

When an `arma-mcp` command is on the shell PATH, use it to chain known steps in one shell call instead of one tool call per step. Every command except `doctor` takes `--stack NAME`, and `ARMA_MCP_STACK` sets it for a whole shell.

- Rebuild cycle: `arma-mcp kill --unlock <mod folder> && <build command> && arma-mcp play <profile>`.
- Exec then wait: `arma-mcp exec -f setup.sqf && arma-mcp wait sqf "!isNil 'X_done'" --timeout 60s`.

Run a chain that can take longer than about two minutes in the shell's background mode, then read its output and exit code. Write large results to a file with `--out` and read only the part you need. A nonzero exit code stops the chain: 1 is a tool or game failure, 3 means the CLI could not use the daemon or the daemon stopped during the command, 4 means another session holds the runtime, and 5 is a wait timeout.

Stay on the MCP tools for single calls. Also stay on them for screenshots you must see, because `exec --capture` only writes the image to a file.

If `arma-mcp` is not on the PATH, stay on the MCP tools. The CLI only connects to a running daemon and never starts one.

On exit code 3, read stderr before you fall back. Redo the step through the MCP tools only when the command never reached the daemon: the CLI could not connect, the daemon refused the session (HTTP 401, 409 or 429) or did not answer it, or the daemon answered `this request was not run`. In any other exit 3 case, such as `the tool may or may not have run` or a connection lost during the command, the step may already have run in game. Check the game state with a read-only exec or the RPT before you redo it.

Commands, quoting, and path rules are in [the CLI guide](../../docs/cli.md).
