// How the suite is cut into shards, kept apart from the runner so it can be tested without a browser.
// CI runs one shard per matrix job and has nothing but the checkout to agree on, so the split may
// depend only on the spec files and the checked-in duration table: same inputs, same shards, on
// every machine.

import { readFileSync } from 'node:fs';

/** `"k/N"` as `{ index: k, count: N }` (1-based), or null when it is not a valid shard. */
export function parseShard(text) {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(text ?? ''));
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) return null;
  return { index, count };
}

/** A whole number ≥ 1, or null. */
export function parseCount(text) {
  return /^\s*\d+\s*$/.test(String(text ?? '')) && Number(text) >= 1 ? Number(text) : null;
}

/**
 * Seconds per spec file from a JSON table (`{ "<file>": <seconds> }`). A missing or unreadable file,
 * or an entry that is not a positive number, counts as unknown: the table is a hint, never an error.
 */
export function loadTimings(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, seconds]) => typeof seconds === 'number' && seconds > 0));
  } catch {
    return {};
  }
}

export function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The units the split places: every spec is a group of one, the fakeCli ones included. They used to
 * be one group, so the suite restarted its server with the fake CLI once; by 2026-10-17 that group
 * was 35 specs and about 900 of the suite's 1,970 seconds, so one CI shard took 16 minutes while
 * the other three took 6 to 7. Each shard runs its own fakeCli specs last, behind one restart of
 * its own server (e2e/run.mjs), which costs seconds. `entries` are `{ file, fake }`.
 */
export function groupSpecs(entries, timings = {}) {
  const known = Object.values(timings);
  const fallback = median(known);
  const weight = (file) => timings[file] ?? fallback;
  const sorted = [...entries].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return sorted.map((e) => ({ files: [e.file], weight: weight(e.file) }));
}

/**
 * Greedy longest-processing-time split into `count` shards: the heaviest group goes first, each to
 * the shard with the least time so far. Ties go by file name and then by the lower shard, so the
 * result is the same everywhere. Returns, per shard, its files (sorted) and its estimated seconds.
 */
export function splitSpecs(entries, timings, count) {
  const groups = groupSpecs(entries, timings).sort((a, b) => b.weight - a.weight || (a.files[0] < b.files[0] ? -1 : a.files[0] > b.files[0] ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const group of groups) {
    let target = shards[0];
    for (const shard of shards) if (shard.seconds < target.seconds) target = shard;
    target.files.push(...group.files);
    target.seconds += group.weight;
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/** One shard per two cores (a server and a Chrome each), at most 4, and never more than there are groups. */
export function defaultShardCount(parallelism, groups) {
  return Math.max(1, Math.min(4, Math.floor(parallelism / 2), groups));
}
