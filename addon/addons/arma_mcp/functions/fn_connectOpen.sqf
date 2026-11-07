/*
 * fn_connectOpen - the main menu row was pressed. Opens the connect window on top
 * of the menu.
 */
params ["_button"];

(ctrlParent _button) createDisplay "AHC_ArmaMCP_RscConnect";
