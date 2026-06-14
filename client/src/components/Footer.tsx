import { Headphones } from "lucide-react";
import { m } from "../paraglide/messages.js";

const REPO_URL = "https://github.com/ogomez92/sonicroom";

// The "Powered by SonicRoom" attribution link (no landmark element on its own).
// Reused both inside the standalone-page Footer below and inside the room's
// existing controls footer, so the active call doesn't gain a second
// `contentinfo` landmark.
export function PoweredBy() {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-xs text-sonic-400 transition-colors hover:text-sonic-accent focus-visible:text-sonic-accent focus-visible:outline-none"
    >
      <Headphones className="h-3.5 w-3.5" aria-hidden="true" />
      {m.footer_powered_by()}
    </a>
  );
}

// Page footer (a `contentinfo` landmark) for the standalone screens — the lobby
// and the room's connecting/error states, none of which have another footer.
export function Footer() {
  return (
    <footer className="flex justify-center border-t border-sonic-700 px-6 py-3">
      <PoweredBy />
    </footer>
  );
}
