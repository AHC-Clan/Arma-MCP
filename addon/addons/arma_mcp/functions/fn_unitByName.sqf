#include "..\script_component.hpp"
/*
 * fn_unitByName - resolves a player NAME to its unit (first exact match, then a
 * case-insensitive fallback). Returns objNull if none. Used by client-mode exec.
 *
 * Argument: _target (string). Returns: unit or objNull.
 */
params [["_target", ""]];
if (_target isEqualTo "") exitWith { objNull };

private _players = allPlayers - entities "HeadlessClient_F";
private _hit = objNull;
{
    if (name _x == _target) exitWith { _hit = _x; };
} forEach _players;

if (isNull _hit) then {
    private _lc = toLower _target;
    {
        if (toLower (name _x) == _lc) exitWith { _hit = _x; };
    } forEach _players;
};
_hit
