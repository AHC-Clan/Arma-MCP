#include "..\script_component.hpp"
/*
 * fn_jsonEsc - escapes a string for embedding inside a JSON string literal.
 * Handles the structural chars \ and " plus CR/LF/TAB. UTF-8 multibyte bytes
 * pass through untouched (Korean text survives). The DLL forwards our body
 * verbatim, so correct escaping here is what makes the frame valid JSON.
 *
 * Vanilla only (no CBA): iterates the byte/codepoint array from toArray.
 *
 * A non-string argument is coerced with format instead of being handed to
 * toArray. toArray raises "Error toarray" on a Number/Object and that aborts
 * this function, so the caller gets nil back and the WHOLE frame body it was
 * assembling is corrupted — a silent loss far worse than a stringified value.
 *
 * Argument: _s (string). Returns: the escaped string (no surrounding quotes).
 */
params [["_s", ""]];
if !(_s isEqualType "") then { _s = format ["%1", _s]; };
if (_s isEqualTo "") exitWith { "" };

private _codes = toArray _s;   // array of Unicode code points
private _out = [];
{
    switch (_x) do {
        case 34: { _out pushBack 92; _out pushBack 34; };   // "  -> \"
        case 92: { _out pushBack 92; _out pushBack 92; };   // \  -> \\
        case 8:  { _out pushBack 92; _out pushBack 98; };   // \b
        case 12: { _out pushBack 92; _out pushBack 102; };  // \f
        case 10: { _out pushBack 92; _out pushBack 110; };  // \n
        case 13: { _out pushBack 92; _out pushBack 114; };  // \r
        case 9:  { _out pushBack 92; _out pushBack 116; };  // \t
        default { _out pushBack _x; };
    };
} forEach _codes;

toString _out
