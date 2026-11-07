#include "..\script_component.hpp"
/*
 * fn_hasCba - true if CBA is loaded. Cached in a mission var so the config lookup
 * runs once. The addon works with or without CBA; this only picks the nicer PFH
 * path when CBA is present.
 */
if (isNil "AHC_ArmaMCP_hasCba") then {
    AHC_ArmaMCP_hasCba = isClass (configFile >> "CfgPatches" >> "cba_main");
};
AHC_ArmaMCP_hasCba
