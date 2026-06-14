// iOS/iPadOS Safari (iPadOS now reports as "MacIntel" + touch). WebKit's audio
// stack should use the device-native sample rate because hardware route changes
// can otherwise interrupt or garble capture.
export const isIOS =
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

// Always request stereo capture. Voice processing is independently selectable:
// browsers may internally downmix while it is enabled, but SonicRoom keeps the
// capture graph and Opus transport stereo-capable.
export function microphoneConstraints(
  deviceId: string,
  voiceProcessingEnabled: boolean,
): MediaTrackConstraints {
  return {
    channelCount: 2,
    ...(isIOS ? {} : { sampleRate: 48000 }),
    echoCancellation: voiceProcessingEnabled,
    noiseSuppression: voiceProcessingEnabled,
    autoGainControl: voiceProcessingEnabled,
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
  };
}
