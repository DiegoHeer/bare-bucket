// Ranged, capped text preview [B5][B6]: the range-header builder and the
// 206-vs-200 truncation decision are pulled out as pure functions (rather
// than inlined in Lightbox.svelte) so they're unit-testable without a DOM
// harness (this project has none; see tests/textPreview.test.ts).
import { TEXT_PREVIEW_CAP_BYTES } from "./preview";

/** `Range` header value for the capped text preview fetch [B6]: `bytes=0-N`
 * where `N` is the last byte INDEX included (inclusive), so a 262144-byte
 * cap asks for bytes 0..262143. */
export function rangeHeaderValue(capBytes: number = TEXT_PREVIEW_CAP_BYTES): string {
  return `bytes=0-${capBytes - 1}`;
}

/** Parses a `Content-Range: bytes 0-262143/500000` response header (present
 * on a 206) into the object's real total size; `null` if the header is
 * absent or unparseable — e.g. a 200 response where the provider ignored our
 * `Range` request entirely has no `Content-Range` at all. */
export function parseContentRangeTotal(contentRange: string | null): number | null {
  if (!contentRange) return null;
  const match = /\/(\d+)\s*$/.exec(contentRange.trim());
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

/**
 * Resolves the object's real total size for the truncation decision, in
 * priority order [B6]: the ranged response's own `Content-Range` total (most
 * authoritative, present on a 206), then a 200 response's `Content-Length`
 * (the full body, since no range was applied so the whole object was — or
 * would have been — sent), then the manifest's last-known size (fallback for
 * when both headers are missing, e.g. a CORS config that doesn't expose them
 * per [B10]).
 */
export function resolveTotalSize(opts: {
  contentRangeTotal: number | null;
  contentLength: number | null;
  manifestSize: number;
}): number {
  return opts.contentRangeTotal ?? opts.contentLength ?? opts.manifestSize;
}

/** [B5]/[B6]: the preview is truncated — and needs the "download for the
 * full file" notice — iff the object's real size exceeds the preview cap. */
export function isTruncated(totalSize: number, capBytes: number = TEXT_PREVIEW_CAP_BYTES): boolean {
  return totalSize > capBytes;
}

/**
 * Reads at most `capBytes` from a response body stream and cancels the
 * underlying reader once the cap is reached. This is what makes the 200 case
 * safe [B6]: a provider that ignores our `Range` header sends the *entire*
 * object, and without this cap a many-gigabyte file would be read fully into
 * memory before we ever got to truncate it for display. A 206 response is
 * already capped server-side, so this just reads it all (already
 * `<= capBytes` by construction) with no extra behavior.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, capBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < capBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = capBytes - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break; // hit the cap mid-chunk; stop pulling more
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export interface TextPreviewResult {
  text: string;
  truncated: boolean;
}

/**
 * Fetches the capped text preview [B6]: a ranged GET on the presigned URL,
 * tolerating both a 206 (provider honored `Range`) and a 200 (provider/CORS
 * ignored it — [B10] covers the CORS side) by capping the read either way.
 * Not unit-tested directly — it's a thin `fetch` composition of the pure
 * helpers above, which are; `signal` lets the caller abort on
 * unmount/navigate.
 */
export async function fetchTextPreview(
  url: string,
  manifestSize: number,
  signal: AbortSignal,
  capBytes: number = TEXT_PREVIEW_CAP_BYTES,
): Promise<TextPreviewResult> {
  const response = await fetch(url, { headers: { Range: rangeHeaderValue(capBytes) }, signal });
  if (!response.ok) {
    throw new Error(`preview failed with status ${response.status}`);
  }

  const contentRangeTotal = parseContentRangeTotal(response.headers.get("Content-Range"));
  const contentLengthHeader = response.headers.get("Content-Length");
  const parsedContentLength = contentLengthHeader !== null ? Number(contentLengthHeader) : NaN;
  const contentLength = response.status === 200 && Number.isFinite(parsedContentLength) ? parsedContentLength : null;

  const bytes = await readCapped(response.body, capBytes);
  const totalSize = resolveTotalSize({ contentRangeTotal, contentLength, manifestSize });

  return { text: new TextDecoder().decode(bytes), truncated: isTruncated(totalSize, capBytes) };
}
