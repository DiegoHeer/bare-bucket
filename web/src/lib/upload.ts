// Upload engine building blocks (spec §5.1 / §7.4). Pure helpers first
// (unit-tested); the XHR driver below is exercised live — `fetch` has no
// upload-progress event, so PUTs go through `XMLHttpRequest`.

/**
 * The first free variant of `name` given a set of already-taken names in
 * the same folder. If `name` itself is free, it's returned unchanged.
 * Otherwise appends " (n)" before the extension, bumping n until free.
 *
 * The split point is the FIRST '.' at index > 0 (not the last) so that
 * multi-part extensions stay intact ("a.tar.gz" -> "a (1).tar.gz") and
 * dotfiles are treated as extensionless (".env" -> ".env (1)", since the
 * leading dot itself doesn't count as a split point).
 */
export function nextFreeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.indexOf(".", 1);
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  let n = 1;
  let candidate = `${base} (${n})${ext}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

export interface PartRange {
  partNumber: number;
  start: number;
  end: number;
}

/** 1-based, contiguous, end-exclusive byte ranges covering `size` exactly. */
export function partRanges(size: number, partSize: number): PartRange[] {
  const ranges: PartRange[] = [];
  let start = 0;
  let partNumber = 1;
  while (start < size) {
    const end = Math.min(start + partSize, size);
    ranges.push({ partNumber, start, end });
    start = end;
    partNumber++;
  }
  return ranges;
}

export interface PutProgress {
  (loadedBytes: number): void;
}

/**
 * PUTs `body` to a presigned `url` via XHR (for upload-progress events,
 * which `fetch` doesn't expose), reporting bytes loaded via `onProgress`.
 * Resolves with the response's ETag header. Rejects on non-2xx (message
 * includes the status), a missing ETag header, a network error, or abort
 * (a `DOMException` named "AbortError", matching `fetch`'s convention so
 * callers can branch on it the same way).
 */
export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: PutProgress,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("upload aborted", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);

    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort);
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`upload failed with status ${xhr.status}`));
        return;
      }
      const etag = xhr.getResponseHeader("ETag");
      if (!etag) {
        reject(new Error("upload succeeded but the response is missing an ETag header"));
        return;
      }
      resolve(etag);
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("network error during upload"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("upload aborted", "AbortError"));
    };
    xhr.send(body);
  });
}
