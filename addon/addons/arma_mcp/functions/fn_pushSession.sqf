#include "..\script_component.hpp"
/*
 * fn_pushSession - builds and pushes the rich sessionInfo snapshot to the DLL.
 * Sent on the connection rising edge (and would be sent on demand). This is what
 * an MCP server that started AFTER the mission uses to catch up immediately.
 *
 * Carries mod capability info (cba, ace, aceVersion, aceComponents, tacmap,
 * tacmapZeusTool) so an agent can actively use ACE/CBA functions via arma_exec and
 * route tactical-map / radio-subtitle work through the arma_tacmap_* tools.
 *
 * Argument: ignored (kept for call-site symmetry).
 */

private _hasAce = call AHC_ArmaMCP_fnc_hasAce;

// ACE version (text — "3.21.0.110"), versionStr fallback.
private _aceVer = "";
if (_hasAce) then {
    _aceVer = getText (configFile >> "CfgPatches" >> "ace_main" >> "version");
    if (_aceVer isEqualTo "") then {
        _aceVer = getText (configFile >> "CfgPatches" >> "ace_main" >> "versionStr");
    };
};

// Detected ACE components (each is its own CfgPatches class). Function calls
// should be gated on the specific component that defines them, so we report the
// present ones. Curated set of the commonly-used subsystems.
private _aceComps = [];
if (_hasAce) then {
    {
        if (isClass (configFile >> "CfgPatches" >> _x)) then { _aceComps pushBack _x; };
    } forEach [
        "ace_common", "ace_medical", "ace_medical_treatment", "ace_medical_engine",
        "ace_interaction", "ace_interact_menu", "ace_cargo", "ace_explosives",
        "ace_map", "ace_maptools", "ace_arsenal", "ace_dragging", "ace_captives",
        "ace_repair", "ace_rearm", "ace_refuel", "ace_zeus", "ace_spectator",
        "ace_hearing", "ace_advanced_fatigue", "ace_advanced_ballistics", "ace_frag"
    ];
};
private _aceCompsJson = "[" + ((_aceComps apply { format ["""%1""", _x] }) joinString ",") + "]";

// AHC_TacticalMap (separate mod): a browser tactical map + an in-game exporter.
// Reported so the agent routes subtitle/map requests through the arma_tacmap_* tools.
// TacMap has no CfgPatches `version`, so presence is the only honest signal.
private _hasTacMap = call AHC_ArmaMCP_fnc_hasTacMap;

// AHC_ZeusTool supplies ONLY the radio SFX (PH_radio_on/off) + colour presets that
// TacMap's zeusTitle borrows. Its absence does NOT disable the subtitle on the MCP
// path (fn_cheatZeusTitle is callable directly and TacMap's client handler is
// registered unconditionally) - it only silences the sound. Reported so a tool can
// say so instead of the agent guessing.
private _hasZeusTool = isClass (configFile >> "CfgPatches" >> "AHC_ZeusTool");

private _body = format [
    "{""world"":""%1"",""mission"":""%2"",""briefing"":""%3"",""server"":""%4"",""dedicated"":%5,""multiplayer"":%6,""cba"":%7,""ace"":%8,""aceVersion"":""%9"",""aceComponents"":%10,""tacmap"":%11,""tacmapZeusTool"":%12,""t"":%13}",
    [worldName] call AHC_ArmaMCP_fnc_jsonEsc,
    [missionName] call AHC_ArmaMCP_fnc_jsonEsc,
    [briefingName] call AHC_ArmaMCP_fnc_jsonEsc,
    [serverName] call AHC_ArmaMCP_fnc_jsonEsc,
    (parseNumber isDedicated),
    (parseNumber isMultiplayer),
    (parseNumber (call AHC_ArmaMCP_fnc_hasCba)),
    (parseNumber _hasAce),
    [_aceVer] call AHC_ArmaMCP_fnc_jsonEsc,
    _aceCompsJson,
    (parseNumber _hasTacMap),
    (parseNumber _hasZeusTool),
    round time
];
EXTENSION callExtension ["pushSession", [_body]];
