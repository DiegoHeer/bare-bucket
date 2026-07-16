// Maps a manifest object's content type to a small emoji glyph used across
// the browse UI (file list/grid rows) — no icon fonts or assets needed.
export function iconFor(contentType: string): string {
  if (contentType.startsWith("image/")) return "🖼";
  if (contentType.startsWith("video/")) return "🎬";
  if (contentType.startsWith("audio/")) return "🎵";
  if (contentType === "application/pdf") return "📄";
  if (contentType.startsWith("text/")) return "📝";
  return "📦";
}
