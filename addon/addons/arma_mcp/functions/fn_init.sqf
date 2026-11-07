#include "..\script_component.hpp"
/*
 * fn_init - postInit entry (runs on every machine at mission start, with or
 * without CBA). Branches to server / client init. The server owns the single
 * authoritative bridge; clients only register the exec run handler so the server
 * can target them.
 */
call AHC_ArmaMCP_fnc_hasCba;   // cache the CBA flag early

if (isServer) then {
    call AHC_ArmaMCP_fnc_initServer;
};
if (hasInterface) then {
    call AHC_ArmaMCP_fnc_initClient;
};
