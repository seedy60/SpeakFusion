import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { useRoomStore, MAX_MIC_GAIN } from "../stores/room";

// Mirror the room's outgoing soft limiter so the previewed level matches what
// peers will actually hear (see MIC_LIMITER in useMediasoup).
const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 };

// Qualitative bands so the meter is usable without sight: the precise value is
// exposed on the role="meter" element, and band *changes* are announced to a
// live region (throttled + change-only, so it never chatters frame-to-frame).
type Band = "silent" | "low" | "good" | "high";
function levelBand(level: number): Band {
  if (level < 0.05) return "silent";
  if (level < 0.2) return "low";
  if (level <= 0.9) return "good";
  return "high";
}
// Empty message = not spoken (you can hear your own silence via the monitor).
const BAND_MESSAGE: Record<Band, string> = {
  silent: "",
  low: "Microphone level low — speak up or raise the slider",
  good: "Microphone level good",
  high: "Microphone level too high — lower the slider",
};

// Test your mic before joining and set a send-side gain (handy for a quiet or
// cheap mic). The value lives in the room store + localStorage, so it carries
// straight into the room.
export function MicPreview() {
  const micGain = useRoomStore((s) => s.micGain);
  const setMicGain = useRoomStore((s) => s.setMicGain);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const meterRef = useRef<HTMLDivElement | null>(null);
  // role="meter" element (precise value, read on demand) + the polite live
  // region that speaks band changes.
  const meterBoxRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);

  // Live-apply slider changes to the preview gain while testing.
  useEffect(() => {
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (ctx && gain) gain.gain.setTargetAtTime(micGain, ctx.currentTime, 0.03);
  }, [micGain]);

  const stop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    gainRef.current = null;
    const bar = meterRef.current;
    if (bar) {
      bar.style.transform = "scaleX(0)";
      bar.style.backgroundColor = "";
    }
    const box = meterBoxRef.current;
    if (box) {
      box.setAttribute("aria-valuenow", "0");
      box.removeAttribute("aria-valuetext");
    }
    const status = statusRef.current;
    if (status) status.textContent = "";
    setTesting(false);
  }, []);

  const start = useCallback(async () => {
    setError("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      setError("Couldn't access your microphone — check the browser permission.");
      return;
    }
    streamRef.current = stream;

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = micGain;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    // Monitor: play the (gained + limited) mic back to the speakers so you can
    // hear yourself — this is exactly the post-processing signal peers receive.
    // Use headphones to avoid the open mic feeding back through the speakers.
    const monitor = ctx.createGain();
    monitor.gain.value = 1;
    source.connect(gain);
    gain.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(monitor);
    monitor.connect(ctx.destination);

    ctxRef.current = ctx;
    gainRef.current = gain;

    const buf = new Float32Array(analyser.fftSize);
    // Closure state for the throttled, change-only screen-reader announcements.
    let lastBand: Band | null = null;
    let lastAnnounceAt = 0;
    const loop = (now: number) => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const level = Math.min(1, rms * 4); // ~rms 0.25 fills the bar
      const bar = meterRef.current;
      if (bar) {
        bar.style.transform = `scaleX(${level})`;
        // Warn (red) as the post-gain signal nears clipping.
        bar.style.backgroundColor = level > 0.9 ? "#f43f5e" : "";
      }

      // Expose the precise value on the meter (read on demand by a screen
      // reader) and speak band changes through the live region.
      const pct = Math.round(level * 100);
      const band = levelBand(level);
      const box = meterBoxRef.current;
      if (box) {
        box.setAttribute("aria-valuenow", String(pct));
        box.setAttribute("aria-valuetext", `${pct}%, ${band} level`);
      }
      if (band !== lastBand && now - lastAnnounceAt > 1200) {
        lastBand = band;
        lastAnnounceAt = now;
        const status = statusRef.current;
        if (status && BAND_MESSAGE[band]) status.textContent = BAND_MESSAGE[band];
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    setTesting(true);
  }, [micGain]);

  // Stop the preview on unmount (e.g. when navigating into the room).
  useEffect(() => () => stop(), [stop]);

  return (
    <div className="rounded-lg border border-sonic-600 bg-sonic-700/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-sonic-200">Mic level</span>
        <span className="font-mono text-xs text-sonic-400">{micGain.toFixed(1)}×</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={testing ? stop : start}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
            testing
              ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
              : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
          }`}
          aria-pressed={testing}
        >
          {testing ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          {testing ? "Stop" : "Test"}
        </button>
        <input
          type="range"
          min="0"
          max={MAX_MIC_GAIN}
          step="0.01"
          value={micGain}
          onChange={(e) => setMicGain(parseFloat(e.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sonic-600 accent-sonic-accent"
          aria-label="Microphone level"
        />
      </div>

      {/* Live level meter — only animates while testing. role="meter" lets a
          screen reader read the exact level on demand (value set via ref). */}
      <div
        ref={meterBoxRef}
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sonic-600"
      >
        <div
          ref={meterRef}
          className="h-full w-full origin-left rounded-full bg-sonic-accent"
          style={{ transform: "scaleX(0)" }}
        />
      </div>

      {/* Spoken band changes (good / too low / too high), throttled in the rAF
          loop so it never chatters. */}
      <div ref={statusRef} role="status" aria-live="polite" className="sr-only" />

      <p className="mt-1.5 text-xs text-sonic-400">
        {error
          ? error
          : testing
            ? "You should hear yourself — use headphones to avoid echo. Raise the slider until the bar sits around the middle."
            : "Quiet or cheap mic? Test it and boost — you'll hear yourself, and the level carries into the room."}
      </p>
    </div>
  );
}
