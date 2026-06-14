import { useEffect, useRef } from "react";
import { Check, X, DoorOpen } from "lucide-react";
import { useRoomStore } from "../stores/room";
import { m } from "../paraglide/messages.js";

// Knock-to-join modal (participant side). Shown to people already in a public
// room while someone is waiting to be let in: one Allow/Deny per requester, plus
// Allow all / Deny all when several are queued.
//
// It's a *real* modal: role="alertdialog" + aria-modal (announced assertively,
// signals a required response), non-dismissible (no Escape, no backdrop click —
// you MUST allow/deny everyone), and it traps keyboard focus. After each
// decision focus lands on the next person's Allow button; once the queue is
// empty the modal unmounts and `onCleared` hands focus back to the call (Room
// opens chat). The looping knock cue is driven from the hook, not here.
export function JoinRequests({
  onDecide,
  onCleared,
}: {
  onDecide: (requestId: string, allow: boolean) => void;
  // Fired on the >0 → 0 transition (everyone has been decided), so the caller
  // can return focus to the call.
  onCleared: () => void;
}) {
  const requests = useRoomStore((s) => s.joinRequests);
  const panelRef = useRef<HTMLDivElement>(null);
  // The first requester's Allow button — where focus parks on appear and after
  // each decision (so it walks onto the next waiting person).
  const firstAllowRef = useRef<HTMLButtonElement>(null);
  const open = requests.length > 0;
  // Track the previous queue length to tell an *opening*/*decision* (focus the
  // next Allow) apart from a *new knock* arriving mid-decision (leave focus put,
  // so a latecomer doesn't yank you around), and to fire onCleared once.
  const prevLenRef = useRef(0);

  useEffect(() => {
    const prevLen = prevLenRef.current;
    prevLenRef.current = requests.length;

    // Just emptied: hand focus back to the caller.
    if (prevLen > 0 && requests.length === 0) {
      onCleared();
      return;
    }
    // First appearance, or a decision shrank the queue: focus the (new) first
    // person's Allow button. A growing queue (new knock) leaves focus alone.
    if (requests.length > 0 && (prevLen === 0 || requests.length < prevLen)) {
      firstAllowRef.current?.focus();
    }
  }, [requests.length, onCleared]);

  if (!open) return null;

  const allowAll = () => requests.forEach((r) => onDecide(r.id, true));
  const denyAll = () => requests.forEach((r) => onDecide(r.id, false));

  // Keyboard focus trap: keep Tab / Shift+Tab cycling within the dialog, and
  // swallow Escape (the dialog is non-dismissible — you must allow/deny).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = panelRef.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panelRef.current?.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panelRef.current?.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      // A press anywhere that isn't a button (the backdrop, or dead space inside
      // the panel) must neither dismiss the dialog nor pull focus off the
      // current button — preventDefault on mousedown stops the blur while still
      // letting button clicks through (it doesn't cancel the click).
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("button")) e.preventDefault();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="join-requests-heading"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-5 shadow-2xl"
      >
        <h2
          id="join-requests-heading"
          className="mb-4 flex items-center gap-2 text-base font-semibold text-sonic-100"
        >
          <DoorOpen className="h-5 w-5 shrink-0 text-sonic-accent" aria-hidden="true" />
          {requests.length === 1
            ? m.join_requests_title_one({ name: requests[0].displayName })
            : m.join_requests_title_many({ count: requests.length })}
        </h2>

        <ul className="mb-4 space-y-2">
          {requests.map((r, i) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 rounded-lg bg-sonic-700/50 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-sonic-100">
                {r.displayName}
              </span>
              <div className="flex shrink-0 gap-2">
                <button
                  ref={i === 0 ? firstAllowRef : undefined}
                  onClick={() => onDecide(r.id, true)}
                  aria-label={m.join_requests_allow_name({ name: r.displayName })}
                  className="flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  {m.join_requests_allow()}
                </button>
                <button
                  onClick={() => onDecide(r.id, false)}
                  aria-label={m.join_requests_deny_name({ name: r.displayName })}
                  className="flex items-center gap-1 rounded-md bg-sonic-600 px-2.5 py-1.5 text-xs font-medium text-sonic-100 hover:bg-red-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  {m.join_requests_deny()}
                </button>
              </div>
            </li>
          ))}
        </ul>

        {requests.length > 1 && (
          <div className="flex justify-end gap-2 border-t border-sonic-600 pt-3">
            <button
              onClick={allowAll}
              className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              {m.join_requests_allow_all()}
            </button>
            <button
              onClick={denyAll}
              className="rounded-md bg-sonic-600 px-3 py-1.5 text-sm font-medium text-sonic-100 hover:bg-red-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              {m.join_requests_deny_all()}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
