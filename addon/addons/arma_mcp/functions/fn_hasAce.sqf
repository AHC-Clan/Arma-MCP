#include "..\script_component.hpp"
/*
 * fn_hasAce - true if ACE (Advanced Combat Environment) is loaded. Cached in a
 * mission var so the config lookup runs once. Detection uses the standard ACE
 * anchor class `ace_main`, so it works on any ACE install (not just this repack).
 *
 * ACE presence is surfaced to the MCP server (sessionInfo) so an agent can
 * confidently call ace_* functions via arma_exec. Subsystem functions should be
 * gated on their own component class (see fn_pushSession's aceComponents).
 */
if (isNil "AHC_ArmaMCP_hasAce") then {
    AHC_ArmaMCP_hasAce = isClass (configFile >> "CfgPatches" >> "ace_main");
};
AHC_ArmaMCP_hasAce
