# Card actions across Web, iOS and Android

`public/card-actions.js` is the canonical order, label and Lucide icon geometry.
Ordinary cards render one compact 32px-high row:
Send message, Conversation, Drafts, Transcript, Open terminal,
Share terminal, Copy conversation link, Rename window, Complete and delete window.
The nine buttons fit in 216px; narrower cards scroll horizontally instead of
wrapping. Web and native share the button dimensions and spacing too.
Vision Pro keeps its larger labelled controls in a wrapping layout.

Unavailable actions remain disabled in their slots. Card read-aloud and its
I/S shortcuts are retired on every client. Platform navigation stays native to each client.
Web uses title hints; native shows the same explanation on long-press.

The mobile repository bundles the exact module and license, so it does not need
an extra network request to render cards. After changing this contract, run in
the mobile checkout:

```sh
node scripts/sync-card-actions.mjs --source ../tmux-mobile/public/card-actions.js
npm run typecheck
npm test -- --run
node scripts/sync-card-actions.mjs --check --source ../tmux-mobile/public/card-actions.js
```

Commit both repositories. Publish Web first, then the runtime 7 iOS/Android OTA
and runtime 6 Android backport from its own dependencies. The production OTA
script checks the hosted Web contract and refuses to publish a mismatched one.
Run the same check before any direct EAS CLI publication. No native binary,
Connector update, Skill or global instruction change is needed.
