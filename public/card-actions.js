// Canonical card action contract for Web, iOS and Android.
// Native bundles an exact copy via scripts/sync-card-actions.mjs.
// Icons: Lucide (ISC), see card-actions.LICENSE.
export const CARD_ACTION_COLUMNS = 5;
export const CARD_ACTIONS = [
  {
    "id": "interact",
    "label": "Send message",
    "hint": "Open the message composer"
  },
  {
    "id": "conversation",
    "label": "Conversation",
    "hint": "Read user messages and final replies"
  },
  {
    "id": "drafts",
    "label": "Drafts",
    "hint": "Review session drafts and comments"
  },
  {
    "id": "transcript",
    "label": "Transcript",
    "hint": "Inspect the full agent transcript"
  },
  {
    "id": "read",
    "label": "Read aloud",
    "hint": "Listen to the last response"
  },
  {
    "id": "terminal",
    "label": "Open terminal",
    "hint": "Open the interactive session terminal"
  },
  {
    "id": "share",
    "label": "Share terminal",
    "hint": "Manage a share link to this terminal"
  },
  {
    "id": "copyLink",
    "label": "Copy conversation link",
    "hint": "Copy a link to this conversation"
  },
  {
    "id": "rename",
    "label": "Rename window",
    "hint": "Change the window name"
  },
  {
    "id": "delete",
    "label": "Complete and delete window",
    "hint": "Complete this session and delete its window"
  }
];
export const CARD_ACTION_ICONS = {
  "interact": [
    [
      "path",
      {
        "d": "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"
      }
    ],
    [
      "path",
      {
        "d": "m21.854 2.147-10.94 10.939"
      }
    ]
  ],
  "conversation": [
    [
      "path",
      {
        "d": "M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"
      }
    ],
    [
      "path",
      {
        "d": "M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"
      }
    ]
  ],
  "drafts": [
    [
      "path",
      {
        "d": "M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z"
      }
    ],
    [
      "path",
      {
        "d": "M14.487 7.858A1 1 0 0 1 14 7V2"
      }
    ],
    [
      "path",
      {
        "d": "M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516"
      }
    ],
    [
      "path",
      {
        "d": "M8 18h1"
      }
    ]
  ],
  "transcript": [
    [
      "path",
      {
        "d": "M3 5h.01"
      }
    ],
    [
      "path",
      {
        "d": "M3 12h.01"
      }
    ],
    [
      "path",
      {
        "d": "M3 19h.01"
      }
    ],
    [
      "path",
      {
        "d": "M8 5h13"
      }
    ],
    [
      "path",
      {
        "d": "M8 12h13"
      }
    ],
    [
      "path",
      {
        "d": "M8 19h13"
      }
    ]
  ],
  "read": [
    [
      "path",
      {
        "d": "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"
      }
    ],
    [
      "path",
      {
        "d": "M16 9a5 5 0 0 1 0 6"
      }
    ],
    [
      "path",
      {
        "d": "M19.364 18.364a9 9 0 0 0 0-12.728"
      }
    ]
  ],
  "terminal": [
    [
      "path",
      {
        "d": "m7 11 2-2-2-2"
      }
    ],
    [
      "path",
      {
        "d": "M11 13h4"
      }
    ],
    [
      "rect",
      {
        "width": "18",
        "height": "18",
        "x": "3",
        "y": "3",
        "rx": "2",
        "ry": "2"
      }
    ]
  ],
  "share": [
    [
      "circle",
      {
        "cx": "18",
        "cy": "5",
        "r": "3"
      }
    ],
    [
      "circle",
      {
        "cx": "6",
        "cy": "12",
        "r": "3"
      }
    ],
    [
      "circle",
      {
        "cx": "18",
        "cy": "19",
        "r": "3"
      }
    ],
    [
      "line",
      {
        "x1": "8.59",
        "x2": "15.42",
        "y1": "13.51",
        "y2": "17.49"
      }
    ],
    [
      "line",
      {
        "x1": "15.41",
        "x2": "8.59",
        "y1": "6.51",
        "y2": "10.49"
      }
    ]
  ],
  "copyLink": [
    [
      "path",
      {
        "d": "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
      }
    ],
    [
      "path",
      {
        "d": "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
      }
    ]
  ],
  "rename": [
    [
      "path",
      {
        "d": "M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6"
      }
    ],
    [
      "path",
      {
        "d": "M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7"
      }
    ],
    [
      "path",
      {
        "d": "M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1"
      }
    ],
    [
      "path",
      {
        "d": "M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1"
      }
    ],
    [
      "path",
      {
        "d": "M9 6v12"
      }
    ]
  ],
  "delete": [
    [
      "path",
      {
        "d": "M10 11v6"
      }
    ],
    [
      "path",
      {
        "d": "M14 11v6"
      }
    ],
    [
      "path",
      {
        "d": "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
      }
    ],
    [
      "path",
      {
        "d": "M3 6h18"
      }
    ],
    [
      "path",
      {
        "d": "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
      }
    ]
  ],
  "stop": [
    [
      "rect",
      {
        "width": "18",
        "height": "18",
        "x": "3",
        "y": "3",
        "rx": "2"
      }
    ]
  ]
};
