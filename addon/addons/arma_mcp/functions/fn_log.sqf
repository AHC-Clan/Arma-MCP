#include "..\script_component.hpp"
/*
 * fn_log - diag_log with the [ArmaMCP] prefix. Argument: a string.
 */
params [["_msg", ""]];
diag_log (format ["%1 %2", LOG_PREFIX, _msg]);
