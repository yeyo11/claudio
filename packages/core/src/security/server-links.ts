import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { ServerLinkCode } from '@claudio/shared';

/**
 * The one-time codes that pair a hub with this server (docs/plans/claudio-servers.md, §4.1). A code
 * is read off one screen and typed into another, so its letters are the ones nobody misreads: no
 * 0/O, 1/I/L. Eight of 31 is about 8.5 × 10¹¹, and the code lives five minutes, is spent by its
 * first use and is voided after a few wrong guesses, on top of the per-peer back-off of the route.
 */
export const SERVER_LINK_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SERVER_LINK_CODE_LENGTH = 8;
export const SERVER_LINK_CODE_TTL_MS = 5 * 60_000;
/**
 * Wrong guesses, from anyone, a live code survives. The back-off is per peer, and an attacker with
 * many addresses has many peers; this bounds what all of them together get per code. The cost is that
 * a flood voids the person's code, which they see and replace.
 */
export const SERVER_LINK_CODE_MAX_WRONG = 20;

/** A refusal a client acts on by its code, with the status it names (the API's error handler reads both) */
export class ServerLinkError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** What a person may type: any case, with the spaces or dashes a display groups it with */
export function normaliseServerLinkCode(value: string): string {
  return value.replace(/[\s-]+/g, '').toUpperCase();
}

interface LiveCode {
  hash: Buffer;
  expires: number;
  wrong: number;
}

/**
 * At most one live code, in memory and as a hash: a restart voids it, which costs the person a new
 * code and keeps a code out of every file.
 */
export class ServerLinkCodes {
  private live: LiveCode | null = null;

  /** The clock is a parameter so a test can let a code expire without waiting five minutes */
  constructor(private readonly now: () => number = Date.now) {}

  /** A new code, replacing any unused one: the screen that shows it is the only one that counts */
  issue(): ServerLinkCode {
    let code = '';
    for (let i = 0; i < SERVER_LINK_CODE_LENGTH; i += 1) code += SERVER_LINK_CODE_ALPHABET[randomInt(SERVER_LINK_CODE_ALPHABET.length)];
    const expires = this.now() + SERVER_LINK_CODE_TTL_MS;
    this.live = { hash: sha256(code), expires, wrong: 0 };
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  /**
   * Whether `presented` is the live code; a right one is spent. The answer does not say whether the
   * code was wrong, expired or already used: each is a guess that failed.
   */
  redeem(presented: string): boolean {
    const live = this.live;
    if (!live) return false;
    if (this.now() >= live.expires) {
      this.live = null;
      return false;
    }
    const digest = sha256(normaliseServerLinkCode(presented));
    if (timingSafeEqual(digest, live.hash)) {
      this.live = null;
      return true;
    }
    live.wrong += 1;
    if (live.wrong >= SERVER_LINK_CODE_MAX_WRONG) this.live = null;
    return false;
  }

  /** Whether a code waits to be redeemed now */
  get pending(): boolean {
    return this.live !== null && this.now() < this.live.expires;
  }
}
