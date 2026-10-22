# Card actions across Web, iOS and Android

`public/card-actions.js` is the canonical order, label and Lucide icon geometry.
Every card renders two rows of five 44px targets, at every viewport size:

1. Send message, Conversation, Drafts, Transcript, Read aloud.
2. Open terminal, Share terminal, Copy conversation link, Rename window, Complete and delete window.

Unavailable actions remain disabled in their slots. Reading changes the fifth
slot to Stop reading. Platform navigation stays native to each client.
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
