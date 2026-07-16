// Pins the transfer engine's async races (spec §5.1/§7.4 fix wave): Complete
// retried through a cancel, a pause interrupting an in-flight part, a resume
// racing the previous run's own unwind, and a per-part retry giving up. The
// engine's only two live dependencies — the wasm client and the XHR PUT
// driver — are swapped via `engineDeps` (the injectable seam) so these run
// against a fully controllable fake client/mock PUT driver instead of a real
// wasm client or network, with deterministic promise resolution standing in
// for real async I/O timing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineDeps, transfers } from "../src/lib/transfers.svelte";
import { session } from "../src/lib/session.svelte";
import type { PresignedRequest, WasmClient } from "../src/lib/core";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PutCall {
  url: string;
  body: Blob;
  signal: AbortSignal;
  deferred: Deferred<string>;
}

/** A `putWithProgress` stand-in that hands the test a controllable
 * `deferred` per call instead of actually doing any I/O — the test decides
 * exactly when (and whether) each PUT "finishes", so the races below are
 * driven by explicit resolve()/reject() calls rather than by racing real
 * timing. Deliberately does NOT auto-reject when `signal` aborts (unlike
 * the real XHR-backed driver) — a real aborted XHR's `onabort` still fires
 * asynchronously, so tests model that explicitly instead of coupling to
 * exactly when it happens. */
function fakePutWithProgress(): {
  fn: typeof engineDeps.putWithProgress;
  calls: PutCall[];
} {
  const calls: PutCall[] = [];
  const fn = vi.fn(
    (url: string, body: Blob, _contentType: string, _onProgress: (loaded: number) => void, signal: AbortSignal) => {
      const deferred = defer<string>();
      calls.push({ url, body, signal, deferred });
      return deferred.promise;
    },
  );
  return { fn, calls };
}

function presigned(url: string): PresignedRequest {
  return { method: "PUT", url, expires_secs: 3600 };
}

interface FakeClient {
  upload_plan: ReturnType<typeof vi.fn>;
  presign_put: ReturnType<typeof vi.fn>;
  presign_upload_part: ReturnType<typeof vi.fn>;
  create_multipart_upload: ReturnType<typeof vi.fn>;
  complete_multipart_upload: ReturnType<typeof vi.fn>;
  abort_multipart_upload: ReturnType<typeof vi.fn>;
  upsert_object: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: { completeMultipartUpload?: () => Promise<string> } = {}): FakeClient {
  return {
    upload_plan: vi.fn(() => ({ kind: "multipart", part_size: 10, part_count: 3 })),
    presign_put: vi.fn(() => presigned("https://example.test/put")),
    presign_upload_part: vi.fn((_key: string, _uploadId: string, partNumber: number) =>
      presigned(`https://example.test/part-${partNumber}`),
    ),
    create_multipart_upload: vi.fn(async () => "upload-1"),
    complete_multipart_upload: vi.fn(overrides.completeMultipartUpload ?? (async () => '"final-etag"')),
    abort_multipart_upload: vi.fn(async () => undefined),
    upsert_object: vi.fn(async () => undefined),
  };
}

function multipartFile(size: number, name = "clip.mp4"): File {
  return new File([new Uint8Array(size)], name, { type: "video/mp4" });
}

function presignedGet(url: string): PresignedRequest {
  return { method: "GET", url, expires_secs: 3600 };
}

interface ReadCall {
  deferred: Deferred<{ done: boolean; value?: Uint8Array }>;
}

/** A `Response.body.getReader()` stand-in whose `read()` hands the test a
 * controllable `deferred` per call, mirroring `fakePutWithProgress` — the
 * test drives the chunk-by-chunk timing explicitly instead of using a real
 * `ReadableStream`. */
function fakeReader(): {
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
  calls: ReadCall[];
} {
  const calls: ReadCall[] = [];
  const reader = {
    read: () => {
      const deferred = defer<{ done: boolean; value?: Uint8Array }>();
      calls.push({ deferred });
      return deferred.promise;
    },
  };
  return { reader, calls };
}

function fakeResponse(
  ok: boolean,
  status: number,
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> } | null,
): Response {
  return {
    ok,
    status,
    body: reader ? { getReader: () => reader } : null,
  } as unknown as Response;
}

interface FakeWritable {
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function fakeWritable(): FakeWritable {
  return {
    write: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
}

interface WriteCall {
  chunk: Uint8Array;
  deferred: Deferred<void>;
}

/** A `writable.write()` stand-in whose calls hand back a controllable
 * `deferred`, mirroring `fakeReader`/`fakePutWithProgress` — lets a test pin
 * the exact moment a write is still in-flight (e.g. to race a cancel against
 * it) instead of racing real I/O timing. */
function fakeControllableWritable(): {
  writable: FakeWritable;
  calls: WriteCall[];
} {
  const calls: WriteCall[] = [];
  const write = vi.fn((chunk: Uint8Array) => {
    const deferred = defer<void>();
    calls.push({ chunk, deferred });
    return deferred.promise;
  });
  return {
    writable: { write, close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) },
    calls,
  };
}

/** Drains the current microtask queue — enough ticks for any chain of
 * plain (non-timer) `await`s in the engine to settle. */
async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

const realPutWithProgress = engineDeps.putWithProgress;
const realGetClient = engineDeps.getClient;
const realPresignGet = engineDeps.presignGet;
const realFetchStream = engineDeps.fetchStream;

describe("transfers engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    transfers.items = [];
    engineDeps.putWithProgress = realPutWithProgress;
    engineDeps.getClient = realGetClient;
    engineDeps.presignGet = realPresignGet;
    engineDeps.fetchStream = realFetchStream;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("cancel during Complete's backoff leaves the row cancelled, skips applyUpsert, and aborts the upload", async () => {
    const put = fakePutWithProgress();
    engineDeps.putWithProgress = put.fn;
    const client = fakeClient({ completeMultipartUpload: () => Promise.reject(new Error("still down")) });
    engineDeps.getClient = () => client as unknown as WasmClient;
    const applyUpsertSpy = vi.spyOn(session, "applyUpsert");

    transfers.enqueue(multipartFile(10), "video.mp4"); // 10 bytes / 10-byte parts -> exactly 1 part
    await flush();
    expect(put.calls).toHaveLength(1);
    put.calls[0].deferred.resolve('"part-etag"');
    await flush();

    const transfer = transfers.items[0];
    expect(transfer.status).toBe("uploading"); // Complete's first attempt has already rejected; now backing off

    await vi.advanceTimersByTimeAsync(150); // partway into the 1s backoff before the 2nd attempt
    await transfers.cancel(transfer.id);
    await vi.advanceTimersByTimeAsync(1000); // let the in-flight backoff tick resolve so it can observe the cancel
    await flush();

    expect(transfer.status).toBe("cancelled");
    expect(applyUpsertSpy).not.toHaveBeenCalled();
    expect(client.abort_multipart_upload).toHaveBeenCalledTimes(1);
    expect(client.abort_multipart_upload).toHaveBeenCalledWith("video.mp4", "upload-1");
  });

  it("pause re-queues the interrupted part and exits the unwind without calling Complete; resuming afterward finishes the upload", async () => {
    const put = fakePutWithProgress();
    engineDeps.putWithProgress = put.fn;
    const client = fakeClient();
    engineDeps.getClient = () => client as unknown as WasmClient;

    transfers.enqueue(multipartFile(30), "clip.mp4"); // 3 parts of 10 bytes
    await flush();
    expect(put.calls).toHaveLength(3); // MAX_CONCURRENT_PARTS=3, all dispatch immediately
    expect(put.calls.map((c) => c.body.size)).toEqual([10, 10, 10]);

    const transfer = transfers.items[0];
    put.calls[0].deferred.resolve('"etag-1"');
    put.calls[1].deferred.resolve('"etag-2"');
    await flush();

    transfers.pause(transfer.id);
    expect(transfer.status).toBe("paused");
    expect(put.calls[2].signal.aborted).toBe(true); // pause() aborted the still-in-flight 3rd part

    // The aborted XHR "finishes" (rejects) while still paused — the worker
    // sees `internal.paused` and re-queues the part instead of retrying it,
    // and the run exits before ever reaching Complete.
    put.calls[2].deferred.reject(new DOMException("upload aborted", "AbortError"));
    await flush();

    expect(client.complete_multipart_upload).not.toHaveBeenCalled();
    expect(transfer.status).toBe("paused"); // still paused; nothing resumed it yet

    transfers.resume(transfer.id);
    await flush();

    expect(client.create_multipart_upload).toHaveBeenCalledTimes(1); // never re-created
    expect(put.calls).toHaveLength(4); // the re-queued part re-uploaded exactly once

    put.calls[3].deferred.resolve('"etag-3"');
    await flush();

    expect(transfer.status).toBe("done");
    expect(client.complete_multipart_upload).toHaveBeenCalledTimes(1);
    const parts = client.complete_multipart_upload.mock.calls[0][2] as { part_number: number; etag: string }[];
    expect(parts.map((p) => p.part_number).sort()).toEqual([1, 2, 3]);
  });

  it("a resume issued while the previous run is still unwinding doesn't trigger a duplicate dispatch, and the queued row still reports its uploadId as active", async () => {
    const put = fakePutWithProgress();
    engineDeps.putWithProgress = put.fn;
    const client = fakeClient();
    engineDeps.getClient = () => client as unknown as WasmClient;

    transfers.enqueue(multipartFile(30), "clip.mp4");
    await flush();
    const transfer = transfers.items[0];
    expect(transfer.uploadId).toBe("upload-1");
    put.calls[0].deferred.resolve('"etag-1"');
    put.calls[1].deferred.resolve('"etag-2"');
    await flush();

    // Pause, then resume in the SAME synchronous tick — before the
    // interrupted 3rd part's promise has settled, let alone before
    // `processFile`'s `finally` clears `internal.running`. `pump()` (called
    // from inside `resume()`) must see the still-active run via the
    // running-flag and decline to start a second, concurrent one.
    transfers.pause(transfer.id);
    transfers.resume(transfer.id);
    expect(transfer.status).toBe("queued");
    expect(transfers.activeUploadIds()).toEqual([transfer.uploadId]);

    // The aborted part's XHR "finishes" only now, after the pause/resume
    // duo already ran — `internal.paused` was flipped back to false by
    // resume() before this was ever observed, so the retry loop just
    // retries the part in place, same as a real abort landing a beat late.
    put.calls[2].deferred.reject(new DOMException("upload aborted", "AbortError"));
    await flush();
    expect(put.calls).toHaveLength(4);
    put.calls[3].deferred.resolve('"etag-3-retry"');
    await flush();

    // Exactly one dispatch ever reached create/Complete — no duplicate run.
    expect(client.create_multipart_upload).toHaveBeenCalledTimes(1);
    expect(client.complete_multipart_upload).toHaveBeenCalledTimes(1);
    expect(transfer.status).toBe("done");
  });

  it("a part that exhausts its one retry re-queues onto pending, errors the transfer, and fires an eager abort", async () => {
    const put = fakePutWithProgress();
    engineDeps.putWithProgress = put.fn;
    const client = fakeClient();
    engineDeps.getClient = () => client as unknown as WasmClient;

    transfers.enqueue(multipartFile(30), "clip.mp4");
    await flush();
    expect(put.calls).toHaveLength(3);

    const transfer = transfers.items[0];
    put.calls[0].deferred.resolve('"etag-1"');
    put.calls[1].deferred.resolve('"etag-2"');
    put.calls[2].deferred.reject(new Error("network blip")); // 3rd part's 1st (of 2 allowed) attempts
    await flush();

    expect(put.calls).toHaveLength(4); // the one allowed retry, dispatched automatically
    put.calls[3].deferred.reject(new Error("network blip again")); // retry also fails — no attempts left
    await flush();

    expect(transfer.status).toBe("error");
    expect(transfer.error).toBe("network blip again");
    expect(client.complete_multipart_upload).not.toHaveBeenCalled();
    expect(client.abort_multipart_upload).toHaveBeenCalledTimes(1);
    expect(client.abort_multipart_upload).toHaveBeenCalledWith("clip.mp4", "upload-1");
  });

  it("download reader loop accumulates progress per chunk and closes the writable exactly once on completion", async () => {
    engineDeps.presignGet = vi.fn(async () => presignedGet("https://example.test/get"));
    const reader = fakeReader();
    engineDeps.fetchStream = vi.fn(async () => fakeResponse(true, 200, reader.reader));
    const writable = fakeWritable();

    transfers.enqueueDownload("photo.png", "photo.png", 10, writable as unknown as FileSystemWritableFileStream);
    await flush();

    expect(engineDeps.presignGet).toHaveBeenCalledWith("photo.png", expect.any(Number), "photo.png");
    const transfer = transfers.items[0];
    expect(transfer.status).toBe("downloading");
    expect(reader.calls).toHaveLength(1);

    reader.calls[0].deferred.resolve({ done: false, value: new Uint8Array([1, 2, 3, 4]) });
    await flush();
    expect(transfer.transferred).toBe(4);
    expect(reader.calls).toHaveLength(2);

    reader.calls[1].deferred.resolve({ done: false, value: new Uint8Array([5, 6, 7, 8, 9, 10]) });
    await flush();
    expect(transfer.transferred).toBe(10);
    expect(reader.calls).toHaveLength(3);

    reader.calls[2].deferred.resolve({ done: true });
    await flush();

    expect(writable.write).toHaveBeenCalledTimes(2);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(transfer.status).toBe("done");
    expect(transfer.transferred).toBe(10);
  });

  it("cancel mid-stream aborts the fetch and the writable, never calls close, and settles cancelled", async () => {
    engineDeps.presignGet = vi.fn(async () => presignedGet("https://example.test/get"));
    const reader = fakeReader();
    let capturedSignal: AbortSignal | undefined;
    engineDeps.fetchStream = vi.fn(async (_url: string, signal: AbortSignal) => {
      capturedSignal = signal;
      return fakeResponse(true, 200, reader.reader);
    });
    const writable = fakeWritable();

    transfers.enqueueDownload("clip.mp4", "clip.mp4", 10, writable as unknown as FileSystemWritableFileStream);
    await flush();
    expect(reader.calls).toHaveLength(1);

    reader.calls[0].deferred.resolve({ done: false, value: new Uint8Array([1, 2, 3]) });
    await flush();
    const transfer = transfers.items[0];
    expect(transfer.transferred).toBe(3);
    expect(reader.calls).toHaveLength(2); // now awaiting the 2nd read()

    await transfers.cancel(transfer.id);

    expect(capturedSignal?.aborted).toBe(true);
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(transfer.status).toBe("cancelled");

    // The in-flight read() rejects only now, as a real aborted fetch stream
    // would — the run's own catch must see `internal.cancelled` and no-op
    // rather than double-aborting the writable or clobbering the status.
    reader.calls[1].deferred.reject(new DOMException("aborted", "AbortError"));
    await flush();

    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(transfer.status).toBe("cancelled");
  });

  it("a non-OK response errors the row and aborts the writable without ever writing or closing", async () => {
    engineDeps.presignGet = vi.fn(async () => presignedGet("https://example.test/get"));
    engineDeps.fetchStream = vi.fn(async () => fakeResponse(false, 403, null));
    const writable = fakeWritable();

    transfers.enqueueDownload("secret.pdf", "secret.pdf", 100, writable as unknown as FileSystemWritableFileStream);
    await flush();

    const transfer = transfers.items[0];
    expect(transfer.status).toBe("error");
    expect(transfer.error).toContain("403");
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.write).not.toHaveBeenCalled();
    expect(writable.close).not.toHaveBeenCalled();
  });

  it("cancel while a write() is in-flight aborts the fetch, settles cancelled, and the write settling afterward doesn't double-abort or close", async () => {
    engineDeps.presignGet = vi.fn(async () => presignedGet("https://example.test/get"));
    const reader = fakeReader();
    let capturedSignal: AbortSignal | undefined;
    engineDeps.fetchStream = vi.fn(async (_url: string, signal: AbortSignal) => {
      capturedSignal = signal;
      return fakeResponse(true, 200, reader.reader);
    });
    const { writable, calls: writeCalls } = fakeControllableWritable();

    transfers.enqueueDownload("clip.mp4", "clip.mp4", 10, writable as unknown as FileSystemWritableFileStream);
    await flush();

    reader.calls[0].deferred.resolve({ done: false, value: new Uint8Array([1, 2, 3]) });
    await flush();
    const transfer = transfers.items[0];
    expect(transfer.transferred).toBe(3);
    expect(writeCalls).toHaveLength(1); // the reader loop is awaiting this write()

    await transfers.cancel(transfer.id);

    expect(capturedSignal?.aborted).toBe(true);
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(transfer.status).toBe("cancelled");
    expect(writable.close).not.toHaveBeenCalled();

    // The in-flight write() rejects only now, as a real aborted sink write
    // would — the run's own catch must see `internal.cancelled` and no-op
    // rather than double-aborting the writable, re-aborting the fetch, or
    // clobbering the status.
    writeCalls[0].deferred.reject(new DOMException("aborted", "AbortError"));
    await flush();

    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
    expect(transfer.status).toBe("cancelled");
  });

  it("a write() failure errors the row, aborts the writable, and aborts the underlying fetch so no dangling reader survives", async () => {
    engineDeps.presignGet = vi.fn(async () => presignedGet("https://example.test/get"));
    const reader = fakeReader();
    let capturedSignal: AbortSignal | undefined;
    engineDeps.fetchStream = vi.fn(async (_url: string, signal: AbortSignal) => {
      capturedSignal = signal;
      return fakeResponse(true, 200, reader.reader);
    });
    const writable = fakeWritable();
    writable.write.mockImplementation(async () => {
      throw new Error("disk full");
    });

    transfers.enqueueDownload("clip.mp4", "clip.mp4", 10, writable as unknown as FileSystemWritableFileStream);
    await flush();

    reader.calls[0].deferred.resolve({ done: false, value: new Uint8Array([1, 2, 3]) });
    await flush();

    const transfer = transfers.items[0];
    expect(transfer.status).toBe("error");
    expect(transfer.error).toContain("disk full");
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
    // This is the one that fails without the fix: without aborting the
    // fetch controller in runDownload's catch, the browser is left pulling
    // response bytes into an abandoned reader.
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("a download queues behind 3 active uploads and dispatches once a slot frees", async () => {
    const put = fakePutWithProgress();
    engineDeps.putWithProgress = put.fn;
    const client = fakeClient();
    engineDeps.getClient = () => client as unknown as WasmClient;

    transfers.enqueue(multipartFile(10, "a.bin"), "a.bin"); // 10 bytes / 10-byte parts -> exactly 1 part each
    transfers.enqueue(multipartFile(10, "b.bin"), "b.bin");
    transfers.enqueue(multipartFile(10, "c.bin"), "c.bin");
    await flush();
    expect(put.calls).toHaveLength(3);
    expect(transfers.items.filter((t) => t.status === "uploading")).toHaveLength(3);

    const presignGetMock = vi.fn(() => new Promise<PresignedRequest>(() => {})); // never resolves; just observes dispatch
    engineDeps.presignGet = presignGetMock;
    engineDeps.fetchStream = vi.fn(() => new Promise<Response>(() => {}));
    const writable = fakeWritable();

    transfers.enqueueDownload("d.bin", "d.bin", 5, writable as unknown as FileSystemWritableFileStream);
    await flush();

    const download = transfers.items.find((t) => t.direction === "download")!;
    expect(download.status).toBe("queued");
    expect(presignGetMock).not.toHaveBeenCalled();

    // Finish exactly one of the three in-flight uploads, freeing a slot.
    put.calls[0].deferred.resolve('"etag"');
    await flush();

    expect(transfers.items.filter((t) => t.direction === "upload" && t.status === "done")).toHaveLength(1);
    expect(download.status).toBe("downloading");
    expect(presignGetMock).toHaveBeenCalledTimes(1);
  });
});
