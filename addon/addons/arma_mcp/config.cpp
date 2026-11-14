#include "script_component.hpp"

class CfgPatches {
    class AHC_ArmaMCP {
        name = "AHC Arma MCP";
        author = "AHC";
        units[] = {};
        weapons[] = {};
        // Deliberately NO cba_main requirement — the addon must load without CBA
        // and detect it at runtime (fn_hasCba).
        // A3_Ui_F so RscDisplayMain exists when this config adds its row.
        requiredAddons[] = {"A3_Ui_F"};
        // hashValue (fn_onExec) needs Arma 2.10+ (2022).
        requiredVersion = 2.10;
        version = "0.5.14";
    };
};

class CfgFunctions {
    class AHC_ArmaMCP {
        tag = "AHC_ArmaMCP";
        class functions {
            file = "ahc\addons\arma_mcp\functions";

            // postInit=1 runs on every machine at mission start WITH OR WITHOUT CBA
            // (vanilla Functions Library feature; not a CBA Extended EH).
            class init { postInit = 1; };

            // The MP lobby slot is not the addon's job: the daemon's server.cfg
            // assigns roles server-side (skipLobby + OnAutoSelectRole). Client SQF
            // cannot take a lobby slot on 2.22 (lbSetCurSel only moves the selection).

            class hasCba {};
            class hasAce {};
            class hasTacMap {};
            class log {};
            class jsonEsc {};

            class initServer {};
            class initClient {};

            class poll {};
            class onExec {};
            class onTelemetryReq {};

            class execRun {};
            class execDispatch {};
            class execRunRemote {};
            class execResultIn {};
            class pushResult {};

            class buildTelemetry {};
            class pushTelemetry {};
            class pushSession {};

            // Main menu "Connect AI Agent" row and window. No mission exists there, so
            // these read other functions from uiNamespace.
            class connectInfo {};
            class connectInfoTick {};
            class connectInfoHover {};
            class connectOpen {};
            class connectOnLoad {};
            class connectTick {};
            class connectRefresh {};
            class connectAction {};

            class unitByName {};
            class openUrl {};
        };
    };
};

#include "ui.hpp"
