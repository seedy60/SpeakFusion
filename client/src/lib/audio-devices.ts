// Speaker (output device) routing. All playback flows through an AudioContext
// (the shared session context in a call; the preview's own context in the
// lobby), so picking a speaker is AudioContext.setSinkId — no per-element
// sink juggling. Safari doesn't implement it; callers hide the picker when
// unsupported so users never see a dead control.

type SinkableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

export function canSelectSpeaker(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

// Route playback to a chosen output device. Only ever called with a REAL device
// id: selecting the default output must NOT go through setSinkId("") — the
// context already plays to the default (which is exactly why Firefox, with no
// setSinkId at all, works), and Edge mishandles the empty-string "default" sink,
// routing a setSinkId("")'d context to no output at all and silencing every
// incoming stream. So an empty id is a no-op here (stay on the natural default);
// a non-default id that's stale/unplugged just rejects and is left as-is rather
// than reverting via the harmful setSinkId("").
export function applySpeakerToContext(ctx: AudioContext, deviceId: string): void {
  const sinkable = ctx as SinkableContext;
  if (!sinkable.setSinkId || !deviceId) return;
  sinkable.setSinkId(deviceId).catch(() => {});
}

// Route an <audio>/<video> element to a chosen output device. Unlike the
// AudioContext form, HTMLMediaElement.setSinkId is mature and handles the empty
// "default" id correctly, so "" (switch back to default) is safe here. Best-effort:
// a stale/unplugged id rejects and is left as-is.
type SinkableElement = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };

export function applySpeakerToElement(el: HTMLMediaElement, deviceId: string): void {
  const sinkable = el as SinkableElement;
  if (!sinkable.setSinkId) return;
  sinkable.setSinkId(deviceId).catch(() => {});
}
