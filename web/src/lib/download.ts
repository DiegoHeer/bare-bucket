// Download entry points (spec §5.2): feature-detect the File System Access
// API and drive its save-picker, plus the universal `<a download>` fallback
// used when FSA (or its secure-context prerequisite) isn't available. The
// streaming engine itself (the reader loop that writes into the picked
// `FileSystemWritableFileStream`) lives in transfers.svelte.ts; this module
// only owns the browser-API glue around it.

interface SaveFilePickerOptions {
  suggestedName?: string;
}

// `showSaveFilePicker` isn't part of this project's TypeScript DOM lib (no
// @types/wicg-file-system-access dependency — "no new deps" per the brief),
// so augment `Window` locally with just the slice this module calls.
declare global {
  interface Window {
    showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  }
}

/** Feature/context gate for the FSA download path (spec §5.2 v1 note):
 * `showSaveFilePicker` is Chromium-only and, like the service worker a
 * StreamSaver-style fallback would need, only exists in a secure context.
 * v1's primary deployment is a plain `http://<private-ip>` LAN/VPN origin,
 * where neither is available — the universal fallback below covers exactly
 * that case. */
export function supportsFsa(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window && window.isSecureContext;
}

/**
 * Prompts for a save location via `showSaveFilePicker` and opens it for
 * writing. Must be called first in the click handler, before any `await` on
 * presign/fetch, so the picker still runs under the click's user activation
 * [B7]. Returns `null` on user cancel (`AbortError`) — a silent no-op, never
 * an error row. Any other rejection (e.g. a permission failure) rethrows so
 * the caller can surface it.
 */
export async function pickSaveTarget(suggestedName: string): Promise<FileSystemWritableFileStream | null> {
  try {
    const handle = await window.showSaveFilePicker!({ suggestedName });
    return await handle.createWritable();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

/**
 * Navigates a temporary, invisible `<a href download>` at `url` to hand the
 * request to the browser's own download manager (spec §5.2's universal
 * fallback) — no fetch, no CORS, no in-page buffering; the browser streams
 * it and shows its own progress. The anchor is created, clicked, and removed
 * synchronously within this call [B1]: `url` is a presigned bearer token, so
 * it must not linger in the DOM (or anywhere reactive) a moment longer than
 * the click needs it.
 */
export function anchorDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = ""; // hint "save, don't navigate"; the actual filename comes from the presigned URL's response-content-disposition
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}
