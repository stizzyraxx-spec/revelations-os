---
description: Demos — admin-only Remotion demo/tutorial video recorder for any portal
---

# /demovid — Demos Feature Spec

> This file is the canonical instructions for the **Demos** feature. It lives at
> `.claude/commands/demovid.md` so that typing `/demovid` in Claude Code resolves
> to it (a loose `demovid.md` at the repo root is NOT reachable as a slash command).
> When the user calls `/demovid`, re-read this file and continue/verify the feature.

## What the user asked for (verbatim intent)

Add a feature to this software, available **only under the admin account**, titled
**Demos**. It lets the admin:

1. Select which **portal** they want to record a demo for.
2. Use **Remotion** + the admin's **ElevenLabs API key** to generate spoken tutorials.
3. Use the **top two male and top two female US voices** from ElevenLabs.
4. Ensure what the voices **say is relevant to what they are seeing** on screen
   (narration is tied to each portal/scene, not generic).
5. When **Demo Mode is enabled**, clicking **any portal** starts rendering a video
   for that portal.
6. Deploy to **production** when done.

## Decisions locked with the user

- **Render engine:** In-browser Remotion capture. Remotion's real renderer needs a
  headless Chromium + ffmpeg, which cannot run in the existing Vercel serverless
  functions (30s limit, no Chrome binary, read-only FS). Instead we drive an
  on-screen scripted walkthrough with Remotion's `@remotion/player` and capture it
  live via the browser `MediaRecorder` API, mixing in ElevenLabs voiceover. This
  reuses libs already in the repo (`src/lib/elevenLabs.js` — `prepareAudio` /
  `scheduleAudio`), needs **zero new paid infra**, and works on prod immediately.
  Output is a downloadable `.webm`/`.mp4`.
- **Admin gate:** `support@cloutfinder.com` (matches the existing `ADMIN_EMAIL` /
  `DISCOVER_ADMIN_EMAIL` checks across the app). Demos is invisible to everyone else.

## Voices (top 2 male + top 2 female, US)

ElevenLabs default US voices, ranked by popularity:

- **Female:** Rachel (`21m00Tcm4TlvDq8ikWAM`), Bella (`EXAVITQu4vr4xnSDxMaL`)
- **Male:** Adam (`pNInz6obpgDQGcFmaJgB`), Antoni (`ErXwobaYiN019PkySvjV`)

The admin can pick which of the four narrates a given demo (default rotates F/M).

## How it works (architecture)

- **`DemoModeContext`** — global toggle (`demoModeEnabled`) + selected voice,
  persisted to `localStorage`. Only mounts/reads as active for the admin email.
- **Demos admin page** (`/demos`, admin-only route + sidebar entry shown only to
  admin) — pick a portal from the full portal list, pick a voice, toggle Demo Mode,
  and preview/record. Also lists the per-portal narration scripts.
- **Portal scripts** (`src/lib/demoScripts.js`) — a map of `portal path → ordered
  scenes`. Each scene has `{ caption, narration, durationMs, highlight }`. The
  narration text describes exactly what the scene shows, so audio matches visuals.
- **Recorder** (`src/components/demos/DemoRecorder.jsx`) — a Remotion `<Player>`
  composition that renders the portal's branded walkthrough (title card → scenes →
  outro). On "Record", it:
  1. Calls `prepareAudio()` with the chosen ElevenLabs voice to synth each scene's
     narration up front.
  2. Starts `MediaRecorder` on the player canvas stream + the mixed audio track.
  3. Plays the composition start→finish, `scheduleAudio()` aligns each voiceover
     clip to its scene start.
  4. On stop, produces a downloadable blob and (optionally) uploads to the Files
     portal via the existing files API.
- **Demo-mode click-to-record** — when Demo Mode is ON (admin only), clicking any
  portal/app tile in the sidebar grid is intercepted: instead of navigating, it
  opens the recorder for that portal and starts rendering. A small floating
  "DEMO MODE" indicator shows it's armed, with a one-click disable.

## Constraints / guardrails

- Strictly admin-gated. No non-admin user ever sees Demos, the toggle, or the
  click interception. Guard on `user?.email === 'support@cloutfinder.com'`.
- ElevenLabs key is **server-side only**: stored as the Vercel env var
  `ELEVENLABS_API_KEY` and used by `/api/ai/tts` (admin-gated). The browser never
  sees the key — the Demos recorder calls `/api/ai/tts`, which proxies ElevenLabs.
  NEVER hard-code or commit a key into client code or git. (A legacy browser-stored
  key path still exists for non-admin tools but is not used by Demos.)
- No new paid services. Reuse `MediaRecorder`, `AudioContext`, and the existing
  ElevenLabs helpers. Remotion packages (`remotion`, `@remotion/player`) are the
  only new deps and are free/open-source.
- Deploy only via `npm run deploy:prod` (the verified pipeline), never bare
  `vercel --prod`.

## Definition of done

- [ ] `/demovid` slash command file exists at `.claude/commands/demovid.md` (this file).
- [ ] Demos page + `/demos` route, admin-only.
- [ ] Sidebar "Demos" entry visible only to admin.
- [ ] Demo Mode toggle persisted; floating indicator when on.
- [ ] Per-portal narration scripts relevant to each portal's UI.
- [ ] Top 2 male + top 2 female US voices selectable.
- [ ] Clicking any portal while Demo Mode is on records that portal's demo.
- [ ] Remotion `<Player>` walkthrough + ElevenLabs voiceover captured to a file.
- [ ] Build passes; deployed to prod via `npm run deploy:prod`.
