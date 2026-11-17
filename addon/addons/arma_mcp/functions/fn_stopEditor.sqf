#include "..\script_component.hpp"
/*
 * fn_stopEditor - Cfg3DEN onMissionPreview. Retires the editor bridge before the
 * preview mission starts its own: raising the generation makes the editor
 * handlers remove themselves on their next call, and shutdown closes the editor's
 * pipe connection. The preview's postInit (fn_initServer) then opens a fresh one.
 * onMissionPreviewEnd starts the editor bridge again (fn_initEditor).
 */
uiNamespace setVariable ["AHC_ArmaMCP_editorGen", (uiNamespace getVariable ["AHC_ArmaMCP_editorGen", 0]) + 1];
AHC_ArmaMCP_serverInit = nil;
EXTENSION callExtension "shutdown";
["editor bridge stopped for preview"] call AHC_ArmaMCP_fnc_log;
