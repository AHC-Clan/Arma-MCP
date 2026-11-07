// ui_defines.hpp — ids for the main menu row and the connect window.

// Main menu row.
#define AHCMCP_IDC_INFO         97301
#define AHCMCP_IDC_INFO_BG      97302
#define AHCMCP_IDC_INFO_BGICON  97303
#define AHCMCP_IDC_INFO_ICON    97304
#define AHCMCP_IDC_INFO_TEXT    97305
#define AHCMCP_IDC_INFO_NOTE    97306
#define AHCMCP_IDC_INFO_BUTTON  97307

// The vanilla SITREP row. The game moves it down on the main branch, so the row
// above it reads its position at load instead of assuming one.
#define AHCMCP_IDC_VANILLA_NEWS 1032

// Connect window.
#define AHCMCP_IDD_CONNECT      97300
#define AHCMCP_IDC_BG           97310
#define AHCMCP_IDC_FRAME        97311
#define AHCMCP_IDC_HEAD         97312
#define AHCMCP_IDC_LEAD         97313
#define AHCMCP_IDC_TITLE        97314

// Rows 0..3: id = AHCMCP_IDC_ROW + row * 10 + one of the offsets below.
#define AHCMCP_IDC_ROW          97320
#define AHCMCP_ROW_LINE         0
#define AHCMCP_ROW_BOX          1
#define AHCMCP_ROW_ICON         2
#define AHCMCP_ROW_NAME         3
#define AHCMCP_ROW_SUB          4
#define AHCMCP_ROW_BARBG        5
#define AHCMCP_ROW_BAR          6
#define AHCMCP_ROW_ACT          7
#define AHCMCP_ROW_ACTFRAME     8
#define AHCMCP_IDC_ENDLINE      97319

#define AHCMCP_IDC_SAY_BG       97360
#define AHCMCP_IDC_SAY_PROMPT   97361
#define AHCMCP_IDC_SAY_QUOTE    97362
#define AHCMCP_IDC_SAY_COPY     97363
#define AHCMCP_IDC_SAY_FRAME    97364

#define AHCMCP_IDC_RAW_BG       97365
#define AHCMCP_IDC_RAW_FRAME    97366
#define AHCMCP_IDC_RAW_TEXT     97367

#define AHCMCP_IDC_NOTE         97370
#define AHCMCP_IDC_LEFT         97371
#define AHCMCP_IDC_LEFT_FRAME   97372
#define AHCMCP_IDC_CLOSE        97373
#define AHCMCP_IDC_CLOSE_FRAME  97374
#define AHCMCP_IDC_PRIMARY      97375

// Sizes in the connect window are written in pixels of the approved mockup, which
// was drawn at a main menu grid unit of 17.7 px, so they scale with the UI size.
#define AHCMCP_MOCK_UNIT 17.7
