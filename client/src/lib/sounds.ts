// Short WebAudio oscillator cues for UI events (mute/unmute, peer join/leave).
// These play locally through the given context's destination — they are never
// routed into the outgoing mic graph, so peers don't hear them. Tones use a
// quick exponential gain envelope so they never click.

export type Cue = "mute" | "unmute" | "join" | "leave";

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

// Each cue is one or two short tones. Rising = positive (unmute/join),
// falling = negative (mute/leave).
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
  }
}
