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

/** Drains the current microtask queue — enough ticks for any chain of
 * plain (non-timer) `await`s in the engine to settle. */
async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

const realPutWithProgress = engineDeps.putWithProgress;
const realGetClient = engineDeps.getClient;

describe("transfers engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    transfers.items = [];
    engineDeps.putWithProgress = realPutWithProgress;
    engineDeps.getClient = realGetClient;
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
});
