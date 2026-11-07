#include "..\script_component.hpp"
/*
 * fn_poll - drains the DLL inbound queue once. Called every frame from the
 * server tick. Exposed as a named function for manual debug-console use.
 */
EXTENSION callExtension "poll"
