// Progress-update throttling (plan item 13 [B2]): caps how often the transfer
// engine writes its reactive `Transfer.transferred` field from a byte-level
// progress callback (XHR upload progress, download reader chunks). Every
// write triggers Svelte reactivity (a DOM update in the transfer panel), so a
// naive per-event write on a fast local network/large file can fire far more
// often than is visible to a human, for no benefit. Pure and DOM-free so the
// threshold logic is unit-testable without XHR/fetch/timers — the transfer
// engine (transfers.svelte.ts) is the only caller.
export interface ProgressPoint {
  bytes: number;
  /** Milliseconds, e.g. `Date.now()` — any monotonically-nondecreasing clock
   * works, this module only ever computes a difference between two points. */
  at: number;
}

/** Byte-delta threshold, as a fraction of `total`: a write is worth doing
 * once at least this much of the whole has moved since the last write. */
const MIN_DELTA_FRACTION = 0.005; // 0.5%

/** Time-delta threshold: a write is worth doing once at least this long has
 * elapsed since the last write, regardless of how few bytes moved. */
const MIN_INTERVAL_MS = 150;

/**
 * Decides whether `next` is worth a reactive write given the last point that
 * WAS written (`lastWrite`) and the transfer's `total` byte count.
 *
 * Always `true` for a terminal reading (`next.bytes >= total`) — the caller
 * must never end up stuck below 100% because the final chunk happened to
 * arrive inside the throttle window — and whenever `total` isn't a usable
 * positive number (nothing to compute a percentage against, so don't
 * silently drop updates). Otherwise `true` iff EITHER at least
 * `MIN_DELTA_FRACTION` of `total` has moved OR at least `MIN_INTERVAL_MS` has
 * elapsed since `lastWrite`, whichever comes first.
 *
 * Pure: callers own tracking what "the last write" was (see
 * transfers.svelte.ts's own `lastWrite` locals) and updating it only when
 * this returns `true`.
 */
export function shouldWriteProgress(lastWrite: ProgressPoint, next: ProgressPoint, total: number): boolean {
  if (total <= 0 || next.bytes >= total) return true;
  const deltaBytes = next.bytes - lastWrite.bytes;
  if (deltaBytes >= total * MIN_DELTA_FRACTION) return true;
  return next.at - lastWrite.at >= MIN_INTERVAL_MS;
}
