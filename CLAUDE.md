# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SonicRoom — low-latency browser audio conferencing (voice) with hi-fi stereo music casting. pnpm monorepo:

- `client/` — React 19 + Vite + Tailwind v4 + zustand, using `mediasoup-client` and `socket.io-client`.
- `server/` — Express 5 + socket.io + `mediasoup` (SFU) + `zod`. Runs TypeScript **directly via `tsx`** (no build artifact).

**Use pnpm, never npm.** It's a pnpm workspace, and `onlyBuiltDependencies` (in `pnpm-workspace.yaml`) builds esbuild and mediasoup's native worker. Reinstalling/adding deps can purge `node_modules` and drop the prebuilt `mediasoup-worker` binary — if the server then fails with a worker error on startup, run `pnpm install` to rebuild it. Also: `pnpm add` (v11) may write a malformed `allowBuilds:` stub into `pnpm-workspace.yaml` that then breaks every `pnpm` run with `ERR_PNPM_IGNORED_BUILDS` on the deps-status check — **delete that stub** (esbuild/mediasoup are already approved via `onlyBuiltDependencies`).

## Commands

```bash
pnpm install                 # workspace install (builds mediasoup worker)
pnpm dev                     # server (tsx watch :3100) + client (vite :5173) together
pnpm dev:server              # server only
pnpm dev:client              # client only — vite proxies /socket.io and /api to :3100
pnpm build                   # builds the CLIENT only -> client/dist (server needs no build)
pnpm start                   # prod: server runs signaling AND serves client/dist statically
pnpm --filter server test    # server tests (node:test via tsx)
```

Run a single server test file / single test:

```bash
pnpm --filter server exec node --import tsx --test src/recording-util.test.ts
pnpm --filter server exec node --import tsx --test --test-name-pattern="PortAllocator" "src/**/*.test.ts"
pnpm --filter client exec tsc --noEmit     # typecheck the client
```

Only the server is tested (pure logic in `recording-util.ts`); the client has no test setup.

## Architecture

### Hybrid P2P ↔ SFU transport (the core idea)

A room dynamically switches transport based on size and needs. **`decideMode(peerCount, currentMode, forceSfu)` in `server/src/recording-util.ts` is the single, pure source of truth** — both the join and leave handlers in `signaling.ts` re-evaluate through it:

- ≤2 peers → **P2P mesh**: clients connect WebRTC directly; the server only relays signaling (`p2p-signal`). Media never touches the server.
- 3+ peers → **mediasoup SFU**.
- `forceSfu` pins the SFU even with ≤2 peers when the server *must* see the media: while **recording** (P2P media is invisible to the server), when a **music caster** is present, or when **`?p2p=off`** was set (`shouldForceSfu` in `signaling.ts`).

On transitions the server emits `switch-to-sfu` / `switch-to-p2p`; the client (`useMediasoup.ts`) tears down one transport stack and builds the other. The outgoing audio graph (below) survives the switch — only senders/producers are rebuilt.

### Client audio graph (`client/src/hooks/useMediasoup.ts`)

One module-scoped shared `AudioContext` for the whole session (resumed on first user gesture for iOS).

- **Outgoing**: `mic → micGain → soft limiter → outDest`. The track added to peers / produced to the SFU is **always `outDest`'s stream track**, so tracks are never swapped on senders/producer across mode switches or when sharing audio. Shared system/tab audio (`getDisplayMedia`) is mixed **straight into `outDest`**, bypassing the mic gain/limiter so music keeps its dynamics.
- **Incoming**: per-peer `MediaStreamSource → gainNode → destination`. `effectiveGain(peerId)` composes per-peer volume × deafen × music ducking; every place that changes gain ramps via `setTargetAtTime`.

### Auto-ducking (controlled client-side)

The server's `AudioLevelObserver` watches **voice producers only** — music/caster producers are deliberately never added to it. It emits `duck {active}` on each on/off transition (`wireDucking` in `signaling.ts`). The **client** does the actual gain ramp: music-peer gain → `volume * DUCK_FACTOR` with `DUCK_ATTACK` (voice starts) / `DUCK_RELEASE` (voice stops) time-constants. Ecobox/the caster just sends raw stereo; ducking timing lives in the client constants, not the caster.

### Music caster (Ecobox)

A send-only "music caster" peer joins with `role: "caster"` (see `joinSchema`). It produces a stereo track but never consumes or sets up P2P, so its presence forces the room onto the SFU. Voice self-limits to **mono 64 kbps** (`forceOpusParams` in `client/src/lib/sdp-munger.ts`, plus `opusStereo:false` on produce). The router's `maxaveragebitrate: 256000` (`mediasoup-config.ts`) is a **ceiling** that lets the stereo caster negotiate hi-fi — **do not lower it to 64000**, that silently clamps music to voice quality.

### Server-side recording (`server/src/recording.ts` + `recording-util.ts`)

Recording is server-side and forces SFU. Per producer: a mediasoup `PlainTransport` pushes RTP to a local UDP port (`PortAllocator` hands out P/P+1 pairs since ffmpeg also opens an RTCP socket at port+1) where an ffmpeg process captures it to a streamable Ogg/Opus file with `-c:a copy` (no re-encode). The download endpoint (`/api/recordings/:id/download`) spawns a **second** ffmpeg that `amix`es all captures (with `adelay` to align late joiners, `normalize=0`) and streams to HTTP `pipe:1` — captures keep running, never interrupted. Recordings are keyed by a `recordingId` capability token, not room name. `RecordingManager` takes injected `RecordingDeps` so the logic is unit-testable without real ffmpeg/mediasoup.

### Client routing

Two routes (`client/src/main.tsx`): `/` → `Lobby`, `/room/:roomName` → `Room`. Room URL params: `?p2p=off` (also false/0/no/disable/disabled) pins SFU; `?displayName=…` deep-links past the lobby name prompt; `?lang=` overrides the UI language (see i18n below). State lives in a single zustand store (`client/src/stores/room.ts`); mic gain persists to localStorage. The room name is reflected into `document.title` from the `Room` component.

### Localization / i18n (Paraglide JS)

UI strings live in `client/messages/{en,es,fr}.json` (flat key→string, `{var}` interpolation). The **inlang Vite plugin** (`paraglideVitePlugin` in `vite.config.ts`) compiles them into tree-shakeable, type-safe functions under `client/src/paraglide/` — **generated, gitignored, never hand-edit** (regenerated on every `pnpm dev`/`pnpm build`; or `pnpm --filter client exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`). `tsconfig` has `allowJs` on so `tsc` reads the JSDoc-typed output. Import message functions from `../paraglide/messages.js` (`m.some_key(...)` or named exports) and call them at render/event time — they read the active locale, so they work in non-React code too.

- **Locale resolution** (`strategy` in `vite.config.ts`, first hit wins): `localStorage` (the picker's choice) → `preferredLanguage` (browser) → `baseLocale` (`en`). On top of that, a **`?lang=` override** is applied imperatively in `client/src/lib/i18n.ts` *before* anything reads the locale (so the store/`main.tsx` import `i18n` to force that ordering), then persisted.
- **Switch without reload**: the locale is mirrored in the store (`locale` + `setLanguage`, which calls Paraglide's `setLocale(…, { reload: false })`). `<App>` in `main.tsx` subscribes to `locale` so a change re-renders the whole tree **in place** — every `m.*()` re-evaluates, but nothing remounts, so an active call survives a mid-session language switch. `setLanguage` also updates `<html lang>`.
- Non-component strings are localized via the same functions: SR announcements in `useMediasoup.ts`, and `client/src/lib/chat.ts` (`formatMessage` stays the single source for both the visible message and its ARIA announcement; `relativeTime` builds a per-locale `Intl.RelativeTimeFormat`).
- **Add a language**: add the code to `locales` in `client/project.inlang/settings.json`, add `messages/<code>.json` (keys at parity with `en.json`), and add its native name to `LOCALE_NAMES` in `client/src/lib/i18n.ts`. The picker (`LanguageSelect`) and detection pick it up automatically.

## Deployment / runtime

- Runs under systemd as **`sonicroom.service`** (`ExecStart=/usr/bin/pnpm start`, `WorkingDirectory=/home/sonicroom`). Env: `PORT` (3100), `ANNOUNCED_IP` / `ANNOUNCED_IP6` (the VPS public IPs — required for ICE), `NODE_ENV=production`. Restart with `systemctl restart sonicroom`.
- **Client changes need only `pnpm build`** — `express.static(client/dist)` serves the new bundle on the next page load, so no server restart and no dropped calls. **Restart the service only for server-code changes** (server runs TS live via tsx).
- Ports: WebRTC media UDP **40000–40100**; recording RTP **50000–50998**. ICE is **UDP-only** by design; TCP/TLS fallback is handled by an external coturn (`turn.oriolgomez.com`). TURN credentials are in client code intentionally (WebRTC requires them browser-side).
