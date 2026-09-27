# AMUX paper style

The user selected Instant’s approved B paper-and-light-glass direction on 2026-09-27 for Web, iOS, Android and the app logo.

Web tokens and component treatment live in `public/paper-theme.css`, loaded after page styles. Native tokens live in sibling `tmux-mobile-mobile/sources/theme.ts`. `kami` remains the stored light-mode value; existing preferences are retained. Reading pages honor the same stored choice.

Light: canvas #f4eee3, paper #fcf8ee, ink #293d2e, forest #264d3d, orange #e0914d. Dark: canvas #17231d, paper #203128, ink #f0eadc, sage #cad9b8, orange #f0b575. Display titles use Georgia with a serif fallback; UI/body text remains readable sans serif. Terminal text remains monospace and ANSI output colors retain their semantics.

Logo generated with the built-in imagegen tool. Prompt: “Original AMUX terminal/session-manager app icon: two elegantly folded forest-green paper strips forming an abstract m / multiplexed terminal pages, one warm-orange circular activity dot; refined editorial paper-and-ink style; crisp small-size silhouette; no text, gradients or extra objects.” Final edit preserved the mark and put it on an opaque ivory square for platform icon masking.

Assets: `public/icon-192.png`, `public/icon-512.png`, `public/apple-touch-icon.png`; native `logo.png`, transparent `logo-mark.png`, iOS AppIcon and splash asset catalogs. Android adaptive icons use the transparent mark on paper.

Android runtime 6 receives a JS-only backport from its existing dependency lockfile. Runtime 7 remains isolated and ships as a new APK; changing runtime labels on incompatible JS is forbidden. Desktop/home-screen icons require the native APK/TestFlight update, not OTA.
