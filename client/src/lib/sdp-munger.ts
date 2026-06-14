/**
 * Force low-latency stereo Opus params in SDP.
 * Ensures useinbandfec=1, maxaveragebitrate=128000, stereo,
 * and minptime=10 for lowest packetization delay.
 */
export function forceOpusParams(sdp: string): string {
  const lines = sdp.split("\r\n");
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith("a=fmtp:") && line.includes("minptime")) {
      // This is an Opus fmtp line — force our params
      const colonIdx = line.indexOf(":");
      const spaceIdx = line.indexOf(" ");
      const payloadType = line.substring(colonIdx + 1, spaceIdx);

      const params = new Map<string, string>();
      const paramStr = line.substring(spaceIdx + 1);
      for (const p of paramStr.split(";")) {
        const [k, v] = p.trim().split("=");
        if (k) params.set(k, v ?? "");
      }

      // Force stereo low-latency params
      params.set("stereo", "1");
      params.set("sprop-stereo", "1");
      params.set("useinbandfec", "1");
      params.set("maxaveragebitrate", "128000");
      params.set("minptime", "10");
      params.set("ptime", "10");
      params.set("maxplaybackrate", "48000");
      params.set("usedtx", "0");

      const newParams = Array.from(params.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join(";");

      result.push(`a=fmtp:${payloadType} ${newParams}`);
    } else {
      result.push(line);
    }
  }

  return result.join("\r\n");
}
