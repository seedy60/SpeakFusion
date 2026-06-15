// Speaker (output device) routing. All playback now flows through real <audio>
// elements (the master mix element in a call; the monitor element in the lobby
// preview) rather than AudioContext.destination — which Edge can leave silent
// even while the graph runs — so picking a speaker is HTMLMediaElement.setSinkId
// on that element. Browsers without setSinkId (older Safari/Firefox) fall back to
// the default device; callers hide the picker via canSelectSpeaker so users never
// see a dead control.

type SinkableElement = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };

export function canSelectSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

// Route an <audio>/<video> element to a chosen output device. HTMLMediaElement.
// setSinkId handles the empty "default" id correctly, so "" (switch back to the
// default device) is safe. Best-effort: a stale/unplugged id rejects and is left
// as-is rather than surfacing an error mid-call.
export function applySpeakerToElement(el: HTMLMediaElement, deviceId: string): void {
  const sinkable = el as SinkableElement;
  if (!sinkable.setSinkId) return;
  sinkable.setSinkId(deviceId).catch(() => {});
}
