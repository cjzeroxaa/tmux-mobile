# Cloud Run Voice Buttons: Missing OpenAI Key

## Debug Report

- **Symptom:** The Cloud Run web app loaded, but the microphone voice-send control and the window audio-read control did not work.
- **Root cause:** The live Cloud Run service did not have `OPENAI_API_KEY` configured. Both `/api/voice-send` and `/api/window-realtime-session` require that key: voice-send uses OpenAI audio transcription, and window audio read mints a Realtime client secret before the browser opens WebRTC to OpenAI.
- **Fix:** Mounted the existing Secret Manager secret `litellm-openai-key` into Cloud Run as `OPENAI_API_KEY`, and granted the Cloud Run runtime service account `roles/secretmanager.secretAccessor` on that secret. Later refreshed `litellm-openai-key` from the 1Password `EnvSecrets-prod / litellm-openai-key` item and rolled the live service to revision `tmux-mobile-controller-00011-qt8`.
- **Code guard:** `server.mjs` now requires `OPENAI_API_KEY` in controller mode startup validation, so this failure becomes a deployment-time error instead of a runtime button failure.
- **Docs:** `README.md` now documents Secret Manager setup and `--set-secrets OPENAI_API_KEY=...` for Cloud Run deploys.
- **Regression test:** `test/e2e-controller.mjs` now supplies a test OpenAI key so the controller e2e covers the full required controller configuration.
- **Verification:** Missing-key controller startup exits with code 2 and says `controller mode requires OPENAI_API_KEY to be set`; `npm test` passes; Cloud Run `/api/health` returns revision `tmux-mobile-controller-00011-qt8`. A real microphone/browser playback click was not exercised from this non-interactive shell.
- **Status:** DONE_WITH_CONCERNS.
