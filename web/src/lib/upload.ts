// Upload engine building blocks (spec §5.1 / §7.4): pure helpers, unit-
// tested. The XHR driver (exercised live, not unit-tested) lands in a
// follow-up commit.

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
