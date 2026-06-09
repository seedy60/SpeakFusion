// Short WebAudio oscillator cues for UI events (mute/unmute, peer join/leave).
// These play locally through the given context's destination — they are never
// routed into the outgoing mic graph, so peers don't hear them. Tones use a
// quick exponential gain envelope so they never click.

export type Cue =
  | "mute"
  | "unmute"
  | "join"
  | "leave"
  | "message"
  | "thunk"
  | "share-start"
  | "share-stop";

interface ToneSpec {
  freq: number;
  // Optional glide target — the pitch ramps from `freq` to `glideTo` over `dur`.
  glideTo?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  // Seconds to wait before this tone starts (lets cues chain two notes).
  delay?: number;
}

function tone(ctx: AudioContext, spec: ToneSpec) {
  const { freq, glideTo, dur, type = "sine", gain = 0.14, delay = 0 } = spec;
  const t0 = ctx.currentTime + delay;

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);

  const g = ctx.createGain();
  // Fast fade-in then exponential fade-out to avoid start/stop clicks.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Each cue has its own contour AND timbre so they're tellable apart by ear
// without looking. Rising sine = positive (unmute/join), falling sine =
// negative (mute/leave); chat uses a brighter triangle, and the spam "thunk"
// is a low dull square — neither can be confused with the voice/presence cues.
export function playCue(ctx: AudioContext, cue: Cue) {
  if (ctx.state === "suspended") ctx.resume();

  switch (cue) {
    case "unmute":
      tone(ctx, { freq: 480, glideTo: 640, dur: 0.12 });
      break;
    case "mute":
      tone(ctx, { freq: 620, glideTo: 440, dur: 0.12 });
      break;
    case "join":
      tone(ctx, { freq: 587, dur: 0.1 });
      tone(ctx, { freq: 880, dur: 0.14, delay: 0.1 });
      break;
    case "leave":
      tone(ctx, { freq: 587, dur: 0.1 });
      tone(ctx, { freq: 392, dur: 0.14, delay: 0.1 });
      break;
    // Incoming chat: two quick bright triangle blips a fifth apart — clearly a
    // "notification", distinct from the rounder sine presence cues.
    case "message":
      tone(ctx, { freq: 784, dur: 0.07, type: "triangle", gain: 0.1 });
      tone(ctx, { freq: 1175, dur: 0.1, type: "triangle", gain: 0.1, delay: 0.075 });
      break;
    // Blocked (rate-limited) send: one low, short, dull square "thunk" with a
    // small downward glide — reads as a soft "nope", not a tone you'd confuse
    // with anything positive.
    case "thunk":
      tone(ctx, { freq: 170, glideTo: 120, dur: 0.13, type: "square", gain: 0.09 });
      break;
    // Audio share toggled: a soft triangle arpeggio — rising (C-E-G) when a
    // share starts, falling when it stops. Distinct from the sine presence cues.
    case "share-start":
      tone(ctx, { freq: 523, dur: 0.09, type: "triangle", gain: 0.1 });
      tone(ctx, { freq: 659, dur: 0.09, type: "triangle", gain: 0.1, delay: 0.08 });
      tone(ctx, { freq: 784, dur: 0.13, type: "triangle", gain: 0.1, delay: 0.16 });
      break;
    case "share-stop":
      tone(ctx, { freq: 784, dur: 0.09, type: "triangle", gain: 0.1 });
      tone(ctx, { freq: 659, dur: 0.09, type: "triangle", gain: 0.1, delay: 0.08 });
      tone(ctx, { freq: 523, dur: 0.13, type: "triangle", gain: 0.1, delay: 0.16 });
      break;
  }
}
