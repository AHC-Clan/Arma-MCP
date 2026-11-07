#include "..\script_component.hpp"
/*
 * fn_hasTacMap - true if AHC_TacticalMap is loaded. Cached in a mission var so the
 * config lookup runs once. Detection uses the addon's CfgPatches class, so it works
 * on any TacMap install. TacMap declares NO `version` entry in CfgPatches, so there
 * is no version string to report - presence is all we can honestly surface.
 *
 * TacMap presence is surfaced to the MCP server (sessionInfo) so an agent proactively
 * routes radio-subtitle / tactical-map requests through the arma_tacmap_* tools
 * instead of improvising raw SQF. The commander seat (AHC_TacticalMap_commander) and
 * the web host/port are RUNTIME state that changes mid-mission - they are deliberately
 * NOT reported here; the tools check them at call time.
 */
if (isNil "AHC_ArmaMCP_hasTacMap") then {
    AHC_ArmaMCP_hasTacMap = isClass (configFile >> "CfgPatches" >> "AHC_TacticalMap");
};
AHC_ArmaMCP_hasTacMap
