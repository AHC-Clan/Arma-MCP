#include "..\script_component.hpp"
/*
 * fn_execRun - compiles and runs an SQF source string on THIS machine and returns
 * a short "TYPE: value" (or "ERROR: ...") summary string. Replicates the verified
 * semantics of AHC_TacticalMap's fn_execRunLocal exactly:
 *
 *   - HARD abort (uncaught throw / nil-as-code) unwinds the block so the trailing
 *     sentinel never runs -> "ERROR: aborted".
 *   - SOFT error (a malformed/typed expression the engine swallows to nil and then
 *     CONTINUES past) -> the sentinel DOES run and _r is nil, so it is IN-BAND
 *     INDISTINGUISHABLE from a legitimate nil return. Both show "<nil>". The RPT
 *     "Error in expression" line is the ONLY source of truth for this class.
 *   - compile almost never returns non-CODE even for broken source, so the
 *     isNil/typeName gate is a rare-case guard, NOT a general parse-error catch.
 *
 * NOTE: compile does NOT preprocess. Any // or /* comment in _src silently
 * corrupts it to <nil>. The MCP server strips comments before sending, so _src
 * should already be comment-free.
 *
 * _r / _reached live in THIS frame (not private to the inner block) so they
 * survive after the block aborts. Summary clamped to 500 chars.
 *
 * Argument: _src (SQF source string). Returns: a summary string (never nil).
 */
params [["_src", ""]];
if (_src isEqualTo "") exitWith { "ERROR: empty code" };

private _code = compile _src;
if (isNil "_code" || {typeName _code != "CODE"}) exitWith { "ERROR: parse failed (see RPT)" };

private _reached = false;
private _r = nil;
_code call {
    _r = call _this;   // statement 1: user code
    _reached = true;   // statement 2: skipped only on a hard abort
};

private _ret =
    if (!_reached) then { "ERROR: aborted (see RPT)" }
    else {
        if (isNil "_r") then { "<nil> (if unexpected, check RPT for 'Error in expression')" }
        else { format ["%1: %2", typeName _r, str _r] }
    };

if (count _ret > 500) then { _ret = (_ret select [0, 500]) + " ...(truncated)"; };
_ret
