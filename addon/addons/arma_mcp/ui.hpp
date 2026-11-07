// ui.hpp — the main menu row and the connect window.
//
// Positions in the window are set by fn_connectRefresh, because its height depends
// on the state. Only looks and events live here.

#include "ui_defines.hpp"

#define AHCMCP_QUOTE(var1) #var1
// sizeEx is line height, so a font drawn at n px in the mockup needs about 1.18 n.
#define AHCMCP_FONT(n) AHCMCP_QUOTE((pixelH * pixelGrid * 2) * n * 1.18 / AHCMCP_MOCK_UNIT)
#define AHCMCP_U(n) AHCMCP_QUOTE(n * (pixelW * pixelGrid * 2))

class RscText;
class RscStructuredText;
class RscPicture;
class RscButton;
class RscFrame;
class RscProgress;
class RscCheckBox;
class RscStandardDisplay;
class RscControlsGroupNoHScrollbars;

// --- main menu row ----------------------------------------------------------
// One row above SITREP in the same look. It is wider than its parent so the
// Korean label fits, and every child gets its own idc: the menu script finds the
// vanilla rows by idc and must not touch this one.
class RscDisplayMain: RscStandardDisplay {
    class controls {
        class InfoMods: RscControlsGroupNoHScrollbars {
            class Controls;
        };
        class InfoNews: InfoMods {
            class Controls: Controls {
                class Background;
                class BackgroundIcon;
                class Icon;
                class News;
                class Notification;
                class Button;
            };
        };
        class AHC_ArmaMCP_Info: InfoNews {
            idc = AHCMCP_IDC_INFO;
            x = "safezoneX + safezoneW - 14 * (pixelW * pixelGrid * 2) - (4 * pixelH)";
            y = "safezoneY + safezoneH - (4 * 2 + 1) * (pixelH * pixelGrid * 2) - 5 * (4 * pixelH)";
            w = AHCMCP_U(14);
            class Controls: Controls {
                class Background: Background {
                    idc = AHCMCP_IDC_INFO_BG;
                    x = AHCMCP_U(6);
                };
                class BackgroundIcon: BackgroundIcon {
                    idc = AHCMCP_IDC_INFO_BGICON;
                    x = AHCMCP_U(10);
                };
                class Icon: Icon {
                    idc = AHCMCP_IDC_INFO_ICON;
                    x = AHCMCP_U(12);
                    text = "ahc\addons\arma_mcp\ui\plug_ca.paa";
                };
                class News: News {
                    idc = AHCMCP_IDC_INFO_TEXT;
                    text = "$STR_AHC_ArmaMCP_Title";
                    w = AHCMCP_U(11.5);
                };
                class Notification: Notification {
                    idc = AHCMCP_IDC_INFO_NOTE;
                    x = AHCMCP_U(13.25);
                };
                class Button: Button {
                    idc = AHCMCP_IDC_INFO_BUTTON;
                    tooltip = "$STR_AHC_ArmaMCP_Tooltip";
                    url = "";
                    w = AHCMCP_U(14);
                    onLoad = "_this call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectInfo')";
                    onButtonClick = "_this call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectOpen')";
                    onMouseEnter = "['enter', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectInfoHover')";
                    onMouseExit = "['exit', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectInfoHover')";
                    onSetFocus = "['enter', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectInfoHover')";
                    onKillFocus = "['exit', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectInfoHover')";
                };
            };
        };
    };
};

// --- connect window: parts --------------------------------------------------
class AHCMCP_Text: RscText {
    idc = -1;
    x = 0; y = 0; w = 0; h = 0;
    shadow = 0;
    font = "RobotoCondensedLight";
    sizeEx = AHCMCP_FONT(17);
    colorBackground[] = {0, 0, 0, 0};
    colorText[] = {1, 1, 1, 1};
    text = "";
};
// Wrapped text. A plain multi-line RscText did not wrap, and its height was wrong.
class AHCMCP_Rich: RscStructuredText {
    idc = -1;
    x = 0; y = 0; w = 0; h = 0;
    shadow = 0;
    size = AHCMCP_FONT(17);
    colorBackground[] = {0, 0, 0, 0};
    class Attributes {
        font = "RobotoCondensedLight";
        color = "#b8ffffff";
        align = "left";
        shadow = 0;
    };
};
class AHCMCP_Fill: AHCMCP_Text {
    colorBackground[] = {1, 1, 1, 0.14};
};
class AHCMCP_Picture: RscPicture {
    idc = -1;
    style = 2096;
    x = 0; y = 0; w = 0; h = 0;
    text = "";
};
class AHCMCP_Frame: RscFrame {
    idc = -1;
    x = 0; y = 0; w = 0; h = 0;
    shadow = 0;
    colorText[] = {1, 1, 1, 0.34};
};
class AHCMCP_Button: RscButton {
    idc = -1;
    x = 0; y = 0; w = 0; h = 0;
    shadow = 0;
    font = "RobotoCondensed";
    sizeEx = AHCMCP_FONT(16);
    colorText[] = {1, 1, 1, 1};
    colorDisabled[] = {1, 1, 1, 0.55};
    colorBackground[] = {1, 1, 1, 0};
    colorBackgroundActive[] = {1, 1, 1, 0.14};
    colorBackgroundDisabled[] = {1, 1, 1, 0.14};
    colorFocused[] = {1, 1, 1, 0.08};
    colorShadow[] = {0, 0, 0, 0};
    colorBorder[] = {0, 0, 0, 0};
    text = "";
};
class AHCMCP_ButtonPrimary: AHCMCP_Button {
    font = "RobotoCondensedBold";
    colorText[] = {0, 0, 0, 1};
    colorBackground[] = {1, 1, 1, 1};
    colorBackgroundActive[] = {0.82, 0.82, 0.82, 1};
    colorFocused[] = {1, 1, 1, 1};
};
class AHCMCP_Bar: RscProgress {
    idc = -1;
    x = 0; y = 0; w = 0; h = 0;
    shadow = 0;
    colorBar[] = {1, 1, 1, 1};
    colorFrame[] = {0, 0, 0, 0};
};
class AHCMCP_Box: RscCheckBox {
    idc = -1;
    x = 0; y = 0; w = 0; h = 0;
    color[] = {1, 1, 1, 1};
    colorFocused[] = {1, 1, 1, 1};
    colorHover[] = {1, 1, 1, 1};
    colorPressed[] = {1, 1, 1, 1};
    textureChecked = "ahc\addons\arma_mcp\ui\box_on_ca.paa";
    textureUnchecked = "ahc\addons\arma_mcp\ui\box_off_ca.paa";
    textureFocusedChecked = "ahc\addons\arma_mcp\ui\box_on_ca.paa";
    textureFocusedUnchecked = "ahc\addons\arma_mcp\ui\box_off_ca.paa";
    textureHoverChecked = "ahc\addons\arma_mcp\ui\box_on_ca.paa";
    textureHoverUnchecked = "ahc\addons\arma_mcp\ui\box_off_ca.paa";
    texturePressedChecked = "ahc\addons\arma_mcp\ui\box_on_ca.paa";
    texturePressedUnchecked = "ahc\addons\arma_mcp\ui\box_off_ca.paa";
    textureDisabledChecked = "ahc\addons\arma_mcp\ui\box_on_ca.paa";
    textureDisabledUnchecked = "ahc\addons\arma_mcp\ui\box_off_ca.paa";
};

// Row controls. T is the tens digit of the ids, so row 0 is 9732x and row 3 is 9735x.
// The offsets match AHCMCP_ROW_* in ui_defines.hpp, and fn_connectAction finds the
// row from the idc.
#define AHCMCP_ROW_CONTROLS(N,T)     class Row##N##Line: AHCMCP_Fill { idc = 973##T##0; };     class Row##N##Box: AHCMCP_Box {         idc = 973##T##1;         onCheckedChanged = "['box', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectAction')";     };     class Row##N##Icon: AHCMCP_Picture { idc = 973##T##2; };     class Row##N##Name: AHCMCP_Text {         idc = 973##T##3;         font = "RobotoCondensed";         sizeEx = AHCMCP_FONT(18);     };     class Row##N##Sub: AHCMCP_Text {         idc = 973##T##4;         sizeEx = AHCMCP_FONT(14);     };     class Row##N##BarBg: AHCMCP_Fill { idc = 973##T##5; };     class Row##N##Bar: AHCMCP_Bar { idc = 973##T##6; };     class Row##N##Act: AHCMCP_Button {         idc = 973##T##7;         onButtonClick = "['row', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectAction')";     };     class Row##N##ActFrame: AHCMCP_Frame { idc = 973##T##8; }

// --- connect window ---------------------------------------------------------
class AHC_ArmaMCP_RscConnect {
    idd = AHCMCP_IDD_CONNECT;
    movingEnable = 0;
    enableSimulation = 1;
    onLoad = "_this call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectOnLoad')";

    class ControlsBackground {
        class Dim: AHCMCP_Text {
            x = "safezoneX";
            y = "safezoneY";
            w = "safezoneW";
            h = "safezoneH";
            colorBackground[] = {0, 0, 0, 0.62};
        };
        class Background: AHCMCP_Text {
            idc = AHCMCP_IDC_BG;
            colorBackground[] = {0.043, 0.043, 0.043, 1};
        };
    };

    class Controls {
        class Frame: AHCMCP_Frame {
            idc = AHCMCP_IDC_FRAME;
            colorText[] = {1, 1, 1, 0.14};
        };
        class Head: AHCMCP_Text {
            idc = AHCMCP_IDC_HEAD;
            colorBackground[] = {1, 1, 1, 1};
        };
        class Title: AHCMCP_Text {
            idc = AHCMCP_IDC_TITLE;
            font = "RobotoCondensedBold";
            sizeEx = AHCMCP_FONT(20);
            colorText[] = {0, 0, 0, 1};
            text = "$STR_AHC_ArmaMCP_Title";
        };
        class Lead: AHCMCP_Rich {
            idc = AHCMCP_IDC_LEAD;
        };

        AHCMCP_ROW_CONTROLS(0,2);
        AHCMCP_ROW_CONTROLS(1,3);
        AHCMCP_ROW_CONTROLS(2,4);
        AHCMCP_ROW_CONTROLS(3,5);
        class EndLine: AHCMCP_Fill { idc = AHCMCP_IDC_ENDLINE; };

        class SayBg: AHCMCP_Text {
            idc = AHCMCP_IDC_SAY_BG;
            colorBackground[] = {1, 1, 1, 0.06};
        };
        class SayPrompt: AHCMCP_Text {
            idc = AHCMCP_IDC_SAY_PROMPT;
            sizeEx = AHCMCP_FONT(15);
            colorText[] = {1, 1, 1, 0.72};
            text = "$STR_AHC_ArmaMCP_SayPrompt";
        };
        class SayQuote: AHCMCP_Text {
            idc = AHCMCP_IDC_SAY_QUOTE;
            font = "RobotoCondensed";
            sizeEx = AHCMCP_FONT(19);
            text = "$STR_AHC_ArmaMCP_SayText";
        };
        class SayCopy: AHCMCP_Button {
            idc = AHCMCP_IDC_SAY_COPY;
            text = "$STR_AHC_ArmaMCP_Copy";
            onButtonClick = "['copySay', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectAction')";
        };
        class SayFrame: AHCMCP_Frame { idc = AHCMCP_IDC_SAY_FRAME; };

        class RawBg: AHCMCP_Text {
            idc = AHCMCP_IDC_RAW_BG;
            colorBackground[] = {0, 0, 0, 1};
        };
        class RawFrame: AHCMCP_Frame {
            idc = AHCMCP_IDC_RAW_FRAME;
            colorText[] = {1, 1, 1, 0.14};
        };
        class RawText: AHCMCP_Rich {
            idc = AHCMCP_IDC_RAW_TEXT;
            size = AHCMCP_FONT(12);
            class Attributes: Attributes {
                font = "EtelkaMonospacePro";
            };
        };

        class Note: AHCMCP_Text {
            idc = AHCMCP_IDC_NOTE;
            sizeEx = AHCMCP_FONT(14);
            colorText[] = {1, 1, 1, 0.55};
        };
        class Left: AHCMCP_Button {
            idc = AHCMCP_IDC_LEFT;
            text = "$STR_AHC_ArmaMCP_CopyDetails";
            onButtonClick = "['copyRaw', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectAction')";
        };
        class LeftFrame: AHCMCP_Frame { idc = AHCMCP_IDC_LEFT_FRAME; };
        class Close: AHCMCP_Button {
            idc = AHCMCP_IDC_CLOSE;
            text = "$STR_AHC_ArmaMCP_Close";
            onButtonClick = "['close', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectAction')";
        };
        class CloseFrame: AHCMCP_Frame { idc = AHCMCP_IDC_CLOSE_FRAME; };
        class Primary: AHCMCP_ButtonPrimary {
            idc = AHCMCP_IDC_PRIMARY;
            onButtonClick = "['primary', _this] call (uiNamespace getVariable 'AHC_ArmaMCP_fnc_connectAction')";
        };
    };
};
