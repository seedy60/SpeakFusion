import { useEffect, useCallback, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Headphones, Users, Loader2, Circle } from "lucide-react";
import { useRoomStore } from "../stores/room";
import { useMediasoup } from "../hooks/useMediasoup";
import { ParticipantCard } from "./ParticipantCard";
import { AudioControls } from "./AudioControls";

type JoinState = "idle" | "joining" | "joined" | "error";

export function Room() {
  const { roomName } = useParams<{ roomName: string }>();
  const navigate = useNavigate();
  const { join, leave, toggleMute, toggleAudioShare, toggleRecording, setPeerVolume } =
    useMediasoup();

  const [joinState, setJoinState] = useState<JoinState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const joinedRef = useRef(false);

  const localPeerId = useRoomStore((s) => s.localPeerId);
  const displayName = useRoomStore((s) => s.displayName);
  const peers = useRoomStore((s) => s.peers);
  const isMuted = useRoomStore((s) => s.isMuted);
  const mode = useRoomStore((s) => s.mode);
  const isRecording = useRoomStore((s) => s.isRecording);
  const announcement = useRoomStore((s) => s.announcement);
  const announceSeq = useRoomStore((s) => s.announceSeq);

  // Join on mount
  useEffect(() => {
    if (joinedRef.current || !roomName) return;
    const name = sessionStorage.getItem("sonicroom:displayName");
    if (!name) {
      navigate(`/?room=${encodeURIComponent(roomName)}`);
      return;
    }

    joinedRef.current = true;
    setJoinState("joining");

    join(roomName, name)
      .then(() => setJoinState("joined"))
      .catch((err) => {
        setJoinState("error");
        setErrorMsg(err instanceof Error ? err.message : "Failed to join");
      });
  }, [roomName, join, navigate]);

  // Keyboard shortcuts
  useEffect(() => {
    if (joinState !== "joined") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleMute();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [joinState, toggleMute]);

  const handleLeave = useCallback(() => {
    leave();
    navigate("/");
  }, [leave, navigate]);

  // Loading state
  if (joinState === "joining") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-sonic-900">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-sonic-accent" />
          <p className="text-sonic-300">Connecting to room...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (joinState === "error") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-sonic-900">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-lg text-muted">{errorMsg}</p>
          <button
            onClick={() => navigate("/")}
            className="rounded-lg bg-sonic-accent px-4 py-2 text-sm text-white hover:bg-sonic-accent/90"
          >
            Back to Lobby
          </button>
        </div>
      </div>
    );
  }

  const peerList = Array.from(peers.values());

  return (
    <div className="flex min-h-dvh flex-col bg-sonic-900">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-sonic-700 px-6 py-3">
        <div className="flex items-center gap-3">
          <Headphones className="h-5 w-5 text-sonic-accent" />
          <h1 className="text-lg font-semibold text-sonic-100">{roomName}</h1>
        </div>
        <div className="flex items-center gap-3 text-sm text-sonic-300">
          {isRecording && (
            <span
              className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium bg-red-500/20 text-red-400"
              title="This call is being recorded"
            >
              <Circle className="h-2.5 w-2.5 animate-pulse fill-red-500 text-red-500" />
              REC
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
            mode === "p2p"
              ? "bg-green-500/20 text-green-400"
              : "bg-blue-500/20 text-blue-400"
          }`}>
            {mode === "p2p" ? "P2P" : "SFU"}
          </span>
          <div className="flex items-center gap-1">
            <Users className="h-4 w-4" />
            <span>{peerList.length + 1}</span>
          </div>
        </div>
      </header>

      {/* Participants grid */}
      <main className="flex flex-1 items-center justify-center p-6">
        <div
          className="grid w-full max-w-4xl grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4"
          role="list"
          aria-label="Room participants"
        >
          {/* Local user */}
          {localPeerId && displayName && (
            <ParticipantCard
              peer={{
                peerId: localPeerId,
                displayName,
                isSpeaking: false,
                isMuted,
                volume: 1,
              }}
              isLocal
            />
          )}

          {/* Remote peers */}
          {peerList.map((peer) => (
            <ParticipantCard
              key={peer.peerId}
              peer={peer}
              isLocal={false}
              onVolumeChange={(v) => setPeerVolume(peer.peerId, v)}
            />
          ))}
        </div>
      </main>

      {/* Bottom controls */}
      <footer className="flex justify-center border-t border-sonic-700 p-4">
        <AudioControls
          onToggleMute={toggleMute}
          onToggleAudioShare={toggleAudioShare}
          onToggleRecording={toggleRecording}
          onLeave={handleLeave}
        />
      </footer>

      {/* Screen reader announcements (peer join/leave, recording, etc.).
          key changes per announcement so identical messages re-announce. */}
      <div aria-live="polite" role="status" className="sr-only" id="sr-announcements">
        <span key={announceSeq}>{announcement}</span>
      </div>
    </div>
  );
}
