import { Mic, MicOff, LogOut, ScreenShare, ScreenShareOff, Circle, Square, Download } from "lucide-react";
import { useRoomStore } from "../stores/room";

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

  return (
    <div
      className="flex items-center justify-center gap-3 rounded-2xl border border-sonic-600 bg-sonic-800 p-3"
      role="toolbar"
      aria-label="Audio controls"
    >
      <button
        onClick={onToggleMute}
        className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
          isMuted
            ? "bg-muted/20 text-muted hover:bg-muted/30"
            : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
        }`}
        aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={isMuted}
        title="Toggle Mute (M)"
      >
        {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
      </button>

      <button
        onClick={onToggleAudioShare}
        className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
          isSharingAudio
            ? "bg-sonic-accent text-white hover:bg-sonic-accent/90"
            : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
        }`}
        aria-label={isSharingAudio ? "Stop sharing audio" : "Share audio"}
        aria-pressed={isSharingAudio}
        title={
          isSharingAudio
            ? "Stop sharing audio"
            : "Share audio — pick a screen/tab and tick 'Share system audio'"
        }
      >
        {isSharingAudio ? (
          <ScreenShareOff className="h-5 w-5" />
        ) : (
          <ScreenShare className="h-5 w-5" />
        )}
      </button>

      <button
        onClick={onToggleRecording}
        className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
          isRecording
            ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
            : "bg-sonic-700 text-sonic-200 hover:bg-sonic-600"
        }`}
        aria-label={isRecording ? "Stop recording" : "Record call"}
        aria-pressed={isRecording}
        title={isRecording ? "Stop recording" : "Record the call (everyone's audio)"}
      >
        {isRecording ? (
          <Square className="h-4 w-4 fill-current" />
        ) : (
          <Circle className="h-5 w-5 fill-red-500 text-red-500" />
        )}
      </button>

      {recordingId && (
        <a
          href={`/api/recordings/${encodeURIComponent(recordingId)}/download`}
          download={`sonicroom-${recordingId}.ogg`}
          className="flex h-11 items-center gap-2 rounded-full bg-sonic-700 px-4 text-sonic-200 transition-all hover:bg-sonic-600"
          aria-label="Download recording"
          title={
            isRecording
              ? "Download everything recorded so far (recording keeps going)"
              : "Download the recording"
          }
        >
          <Download className="h-4 w-4" />
          <span className="text-sm font-medium">Download</span>
        </a>
      )}

      <div className="h-8 w-px bg-sonic-600" role="separator" />

      <button
        onClick={onLeave}
        className="flex h-11 items-center gap-2 rounded-full bg-muted/20 px-4 text-muted transition-all hover:bg-muted/30"
        aria-label="Leave room"
      >
        <LogOut className="h-4 w-4" />
        <span className="text-sm font-medium">Leave</span>
      </button>
    </div>
  );
}
