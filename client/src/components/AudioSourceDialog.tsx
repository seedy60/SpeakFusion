import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { FileMusic, FolderOpen, Link, X } from "lucide-react";
import { m } from "../paraglide/messages.js";

interface AudioSourceDialogProps {
  onClose: () => void;
  onChooseComputerFile: () => void;
  onStartUrl: (url: string) => Promise<void>;
  onStartServerFile: (name: string) => Promise<void>;
}

export function AudioSourceDialog({
  onClose,
  onChooseComputerFile,
  onStartUrl,
  onStartServerFile,
}: AudioSourceDialogProps) {
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    urlInputRef.current?.focus();
    let active = true;
    void fetch("/api/audio-library")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        return (await res.json()) as { files?: string[] };
      })
      .then(({ files: nextFiles }) => {
        if (!active || !Array.isArray(nextFiles)) return;
        setFiles(nextFiles);
        setSelectedFile(nextFiles[0] ?? "");
      })
      .catch(() => active && setError(m.audio_source_error()))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const start = async (action: () => Promise<void>) => {
    setStarting(true);
    setError("");
    try {
      await action();
      onClose();
    } catch {
      setError(m.audio_source_error());
      setStarting(false);
    }
  };

  const submitUrl = (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (value) void start(() => onStartUrl(value));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-source-heading"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-xl border border-sonic-600 bg-sonic-800 p-4 shadow-2xl"
      >
        <div className="mb-4 flex items-center gap-2">
          <FileMusic className="h-5 w-5 text-sonic-accent" aria-hidden="true" />
          <h2 id="audio-source-heading" className="text-base font-semibold text-sonic-100">
            {m.audio_source_heading()}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-sonic-300 hover:bg-sonic-700 hover:text-sonic-100"
            aria-label={m.audio_source_close()}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <button
          type="button"
          disabled={starting}
          onClick={onChooseComputerFile}
          className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-sonic-700 px-3 py-2 text-sm font-medium text-sonic-100 hover:bg-sonic-600 disabled:opacity-50"
        >
          <FolderOpen className="h-4 w-4" />
          {m.audio_source_computer()}
        </button>

        <form onSubmit={submitUrl} className="mb-4">
          <label htmlFor="audio-source-url" className="mb-1 block text-xs font-medium text-sonic-300">
            {m.audio_source_url_label()}
          </label>
          <div className="flex gap-2">
            <input
              ref={urlInputRef}
              id="audio-source-url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={m.audio_source_url_placeholder()}
              className="min-w-0 flex-1 rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 placeholder-sonic-400 focus:border-sonic-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={starting || !url.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-sonic-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              <Link className="h-4 w-4" />
              {m.audio_source_url_start()}
            </button>
          </div>
        </form>

        <label htmlFor="audio-source-library" className="mb-1 block text-xs font-medium text-sonic-300">
          {m.audio_source_library_label()}
        </label>
        {loading ? (
          <p className="text-xs text-sonic-400">{m.audio_source_loading()}</p>
        ) : files.length === 0 ? (
          <p className="text-xs text-sonic-400">{m.audio_source_library_empty()}</p>
        ) : (
          <div className="flex gap-2">
            <select
              id="audio-source-library"
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-sonic-600 bg-sonic-700 px-2.5 py-1.5 text-sm text-sonic-100 focus:border-sonic-accent focus:outline-none"
            >
              {files.map((file) => (
                <option key={file} value={file}>
                  {file}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={starting || !selectedFile}
              onClick={() => void start(() => onStartServerFile(selectedFile))}
              className="rounded-lg bg-sonic-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {m.audio_source_library_start()}
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-muted">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
