import { useRef, useState, type KeyboardEvent } from "react";
import { Mic, MicOff, LogOut, ScreenShare, ScreenShareOff, Circle, Square, Download } from "lucide-react";
import { useRoomStore } from "../stores/room";
import { m } from "../paraglide/messages.js";

interface AudioControlsProps {
  onToggleMute: () => void;
  onToggleAudioShare: () => void;
  onToggleRecording: () => void;
  onLeave: () => void;
}

export function AudioControls({
  onToggleMute,
  onToggleAudioShare,
  onToggleRecording,
  onLeave,
}: AudioControlsProps) {
  const isMuted = useRoomStore((s) => s.isMuted);
  const isSharingAudio = useRoomStore((s) => s.isSharingAudio);
  const isRecording = useRoomStore((s) => s.isRecording);
  const recordingId = useRoomStore((s) => s.recordingId);

  // Roving tabindex: the toolbar is a single tab stop and left/right arrows
  // move focus between its controls (ARIA toolbar pattern).
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [activeId, setActiveId] = useState("mute");

  const orderedIds = ["mute", "share", "record", ...(recordingId ? ["download"] : []), "leave"];
  // If the active control vanished (e.g. the download link), fall back to the first.
  const effectiveActiveId = orderedIds.includes(activeId) ? activeId : orderedIds[0];

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) itemRefs.current.set(id, el);
    else itemRefs.current.delete(id);
  };

  const item = (id: string) => ({
    ref: register(id),
    tabIndex: effectiveActiveId === id ? 0 : -1,
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const { key } = e;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
    e.preventDefault();
    const idx = orderedIds.indexOf(effectiveActiveId);
    const last = orderedIds.length - 1;
    const nextIdx =
      key === "Home"
        ? 0
        : key === "End"
          ? last
          : key === "ArrowRight"
            ? (idx + 1) % orderedIds.length
            : (idx - 1 + orderedIds.length) % orderedIds.length;
    const nextId = orderedIds[nextIdx];
    setActiveId(nextId);
    itemRefs.current.get(nextId)?.focus();
  };

  return (
    <div
      className="flex items-center justify-center gap-3 rounded-2xl border border-sonic-600 bg-sonic-800 p-3"
      role="toolbar"
      aria-label={m.controls_toolbar_label()}
      onKeyDown={onKeyDown}
    >
      <button
        {...item("mute")}
        onClick={onToggleMute}
        className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
          isMuted
            ? "bg-muted/20 text-muted hover:bg-muted/30"
            : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
        }`}
        aria-label={isMuted ? m.controls_unmute() : m.controls_mute()}
        title={m.controls_mute_title()}
      >
        {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </button>

      <button
        {...item("share")}
        onClick={onToggleAudioShare}
        className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
          isSharingAudio
            ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
            : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
        }`}
        aria-label={isSharingAudio ? m.controls_stop_share() : m.controls_share()}
        aria-pressed={isSharingAudio}
        title={isSharingAudio ? m.controls_stop_share_title() : m.controls_share_title()}
      >
        {isSharingAudio ? (
          <ScreenShareOff className="h-5 w-5" />
        ) : (
          <ScreenShare className="h-5 w-5" />
        )}
      </button>

      <button
        {...item("record")}
        onClick={onToggleRecording}
        className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
          isRecording
            ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
            : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
        }`}
        aria-label={isRecording ? m.controls_stop_recording() : m.controls_record()}
        aria-pressed={isRecording}
        title={isRecording ? m.controls_stop_recording_title() : m.controls_record_title()}
      >
        {isRecording ? (
          <Square className="h-4 w-4 fill-current" />
        ) : (
          <Circle className="h-5 w-5 fill-red-500 text-red-500" />
        )}
      </button>

      {recordingId && (
        <a
          {...item("download")}
          href={`/api/recordings/${encodeURIComponent(recordingId)}/download`}
          download={`sonicroom-${recordingId}.ogg`}
          className="flex h-11 items-center gap-2 rounded-full bg-sonic-700 px-4 text-sonic-200 transition-all hover:bg-sonic-600"
          aria-label={m.controls_download_recording()}
          title={isRecording ? m.controls_download_active_title() : m.controls_download_title()}
        >
          <Download className="h-4 w-4" />
          <span className="text-sm font-medium">{m.controls_download()}</span>
        </a>
      )}

      <div className="h-8 w-px bg-sonic-600" role="separator" />

      <button
        {...item("leave")}
        onClick={onLeave}
        className="flex h-11 items-center gap-2 rounded-full bg-muted/20 px-4 text-muted transition-all hover:bg-muted/30"
        aria-label={m.controls_leave_room()}
      >
        <LogOut className="h-4 w-4" />
        <span className="text-sm font-medium">{m.controls_leave()}</span>
      </button>
    </div>
  );
}
