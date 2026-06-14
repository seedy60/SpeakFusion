import { useId, useState } from "react";
import { Radio, Loader2 } from "lucide-react";
import { useRoomStore, type StreamConfig, type StreamFormat } from "../stores/room";
import { m } from "../paraglide/messages.js";

interface StreamSettingsProps {
  // Resolves once the server accepts the target and the mixer is starting;
  // rejects with the server's reason (bad host/credentials, etc.).
  onStartStreaming: () => Promise<void>;
  onStopStreaming: () => Promise<void>;
}

// Icecast streaming controls inside the in-call settings panel. Reads/writes the
// persisted streamConfig in the store and starts/stops the room-wide live
// stream. The target (incl. password) is stored locally and sent to the server
// on start; it's never shown to other peers.
export function StreamSettings({ onStartStreaming, onStopStreaming }: StreamSettingsProps) {
  const isStreaming = useRoomStore((s) => s.isStreaming);
  const config = useRoomStore((s) => s.streamConfig);
  const setStreamConfig = useRoomStore((s) => s.setStreamConfig);
  // Async failure reported by the server after we'd gone live (the start() call
  // already returned); the start() rejection is captured in local `error`.
  const streamError = useRoomStore((s) => s.streamError);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Show the inline rejection if we have one, otherwise the server's later report.
  const shownError = error || streamError;

  const hostId = useId();
  const portId = useId();
  const mountId = useId();
  const userId = useId();
  const passId = useId();
  const formatId = useId();
  const bitrateId = useId();

  const update = (patch: Partial<StreamConfig>) => setStreamConfig({ ...config, ...patch });

  const canStart = config.host.trim().length > 0 && config.password.length > 0;

  const onToggle = async () => {
    setError("");
    setBusy(true);
    try {
      if (isStreaming) await onStopStreaming();
      else await onStartStreaming();
    } catch (err) {
      setError(err instanceof Error ? err.message : m.streaming_start_error());
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 transition-colors focus:border-sonic-accent focus:outline-none disabled:opacity-50";
  const labelClass = "mb-1 block text-xs font-medium text-sonic-300";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-sonic-accent" />
        <h2 className="text-sm font-semibold text-sonic-100">{m.settings_streaming_heading()}</h2>
      </div>
      <p className="text-xs text-sonic-400">{m.settings_streaming_hint()}</p>

      <div>
        <label htmlFor={hostId} className={labelClass}>
          {m.streaming_host_label()}
        </label>
        <input
          id={hostId}
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="stream.example.com"
          value={config.host}
          disabled={isStreaming}
          onChange={(e) => update({ host: e.target.value })}
          className={inputClass}
        />
      </div>

      <div className="flex gap-2">
        <div className="w-24">
          <label htmlFor={portId} className={labelClass}>
            {m.streaming_port_label()}
          </label>
          <input
            id={portId}
            type="number"
            min={1}
            max={65535}
            value={config.port}
            disabled={isStreaming}
            onChange={(e) => update({ port: Number(e.target.value) || 0 })}
            className={inputClass}
          />
        </div>
        <div className="flex-1">
          <label htmlFor={mountId} className={labelClass}>
            {m.streaming_mount_label()}
          </label>
          <input
            id={mountId}
            type="text"
            autoComplete="off"
            placeholder="/sonicroom"
            value={config.mount}
            disabled={isStreaming}
            onChange={(e) => update({ mount: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor={userId} className={labelClass}>
            {m.streaming_user_label()}
          </label>
          <input
            id={userId}
            type="text"
            autoComplete="off"
            placeholder="source"
            value={config.username}
            disabled={isStreaming}
            onChange={(e) => update({ username: e.target.value })}
            className={inputClass}
          />
        </div>
        <div className="flex-1">
          <label htmlFor={passId} className={labelClass}>
            {m.streaming_password_label()}
          </label>
          <input
            id={passId}
            type="password"
            autoComplete="off"
            value={config.password}
            disabled={isStreaming}
            onChange={(e) => update({ password: e.target.value })}
            className={inputClass}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor={formatId} className={labelClass}>
            {m.streaming_format_label()}
          </label>
          <select
            id={formatId}
            value={config.format}
            disabled={isStreaming}
            onChange={(e) => update({ format: e.target.value as StreamFormat })}
            className={inputClass}
          >
            <option value="mp3">{m.streaming_format_mp3()}</option>
            <option value="opus">{m.streaming_format_opus()}</option>
          </select>
        </div>
        <div className="w-28">
          <label htmlFor={bitrateId} className={labelClass}>
            {m.streaming_bitrate_label()}
          </label>
          <input
            id={bitrateId}
            type="number"
            min={32}
            max={320}
            step={16}
            value={config.bitrateKbps}
            disabled={isStreaming}
            onChange={(e) => update({ bitrateKbps: Number(e.target.value) || 160 })}
            className={inputClass}
          />
        </div>
      </div>

      {shownError && (
        <p role="alert" className="text-xs text-red-400">
          {shownError}
        </p>
      )}

      {/* Only this client knows the target if it started the stream — a late
          joiner sees the LIVE badge but no (stale, defaulted) target here. */}
      {isStreaming && config.host.trim() && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-red-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
          {m.streaming_live_status({ target: `${config.host}${config.mount}` })}
        </p>
      )}

      <button
        type="button"
        onClick={onToggle}
        disabled={busy || (!isStreaming && !canStart)}
        className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
          isStreaming
            ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
            : "bg-sonic-accent text-white hover:bg-sonic-accent/90"
        }`}
        title={isStreaming ? m.streaming_stop_title() : m.streaming_start_title()}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {isStreaming ? m.streaming_stop() : m.streaming_start()}
      </button>
    </div>
  );
}
