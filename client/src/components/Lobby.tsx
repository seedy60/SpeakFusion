import { useState, useCallback, useRef, useEffect, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Headphones, ArrowRight } from "lucide-react";
import { MicPreview } from "./MicPreview";

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "");
}

// `?p2p=off` (also accepts false/0/no/disable/disabled) means P2P is disabled —
// used to seed the checkbox from a shared link.
function isP2pDisabled(value: string | null): boolean {
  if (value == null) return false;
  return ["off", "false", "0", "no", "disable", "disabled"].includes(value.toLowerCase());
}

export function Lobby() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillRoom = searchParams.get("room") || "";
  const [roomName, setRoomName] = useState(sanitize(prefillRoom));
  const [displayName, setDisplayName] = useState("");
  const [disableP2p, setDisableP2p] = useState(() => isP2pDisabled(searchParams.get("p2p")));
  const roomInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefillRoom) {
      nameInputRef.current?.focus();
    } else {
      roomInputRef.current?.focus();
    }
  }, [prefillRoom]);
  const [error, setError] = useState("");

  const handleJoin = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      const sanitizedRoom = sanitize(roomName.trim());
      const trimmedName = displayName.trim().replace(/[<>"'&]/g, "");

      if (!sanitizedRoom) {
        setError("Room name is required (alphanumeric, hyphens, underscores)");
        return;
      }
      if (sanitizedRoom.length > 64) {
        setError("Room name must be 64 characters or less");
        return;
      }
      if (!trimmedName) {
        setError("Display name is required");
        return;
      }
      if (trimmedName.length > 256) {
        setError("Display name must be 256 characters or less");
        return;
      }

      // Store display name for the Room component
      sessionStorage.setItem("sonicroom:displayName", trimmedName);
      // Pass `?p2p=off` to the room so it stays on the SFU instead of P2P.
      navigate(disableP2p ? `/room/${sanitizedRoom}?p2p=off` : `/room/${sanitizedRoom}`);
    },
    [roomName, displayName, navigate, disableP2p],
  );

  return (
    <div className="flex min-h-dvh items-center justify-center bg-sonic-900">
      <div className="w-full max-w-md rounded-2xl border border-sonic-600 bg-sonic-800 p-8 shadow-2xl">
        <div className="mb-8 flex items-center justify-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-sonic-accent/20">
            <Headphones className="h-6 w-6 text-sonic-accent" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-sonic-100">
            SonicRoom
          </h1>
        </div>

        <p className="mb-6 text-center text-sm text-sonic-300">
          Ultra-low-latency stereo audio conferencing
        </p>

        <form onSubmit={handleJoin} className="space-y-4">
          <div>
            <label
              htmlFor="room-name"
              className="mb-1.5 block text-sm font-medium text-sonic-200"
            >
              Room Name
            </label>
            <input
              ref={roomInputRef}
              id="room-name"
              type="text"
              value={roomName}
              onChange={(e) => {
                setRoomName(e.target.value);
                setError("");
              }}
              placeholder="my-studio"
              maxLength={64}
              className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-4 py-2.5 text-sonic-100 placeholder-sonic-400 transition-colors focus:border-sonic-accent focus:outline-none"
              autoComplete="off"
              aria-describedby={error ? "lobby-error" : undefined}
            />
          </div>

          <div>
            <label
              htmlFor="display-name"
              className="mb-1.5 block text-sm font-medium text-sonic-200"
            >
              Display Name
            </label>
            <input
              ref={nameInputRef}
              id="display-name"
              type="text"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setError("");
              }}
              placeholder="Your name"
              maxLength={256}
              className="w-full rounded-lg border border-sonic-600 bg-sonic-700 px-4 py-2.5 text-sonic-100 placeholder-sonic-400 transition-colors focus:border-sonic-accent focus:outline-none"
              autoComplete="off"
            />
          </div>

          <MicPreview />

          <label className="flex cursor-pointer select-none items-start gap-2.5">
            <input
              type="checkbox"
              checked={disableP2p}
              onChange={(e) => setDisableP2p(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-sonic-600 bg-sonic-700 accent-sonic-accent"
            />
            <span className="text-sm font-medium text-sonic-200">
              Disable P2P
              <span className="mt-0.5 block text-xs font-normal text-sonic-400">
                Always relay audio through the SFU instead of a direct peer-to-peer
                connection, even with two participants.
              </span>
            </span>
          </label>

          {error && (
            <p id="lobby-error" className="text-sm text-muted" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-sonic-accent px-4 py-2.5 font-medium text-white transition-all hover:bg-sonic-accent/90 hover:shadow-lg hover:shadow-sonic-accent/25 active:scale-[0.98]"
          >
            Join Room
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-sonic-400">
          <kbd className="rounded border border-sonic-600 bg-sonic-700 px-1.5 py-0.5 font-mono text-sonic-300">
            M
          </kbd>{" "}
          Toggle Mute
        </div>
      </div>
    </div>
  );
}
