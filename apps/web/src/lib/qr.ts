/*
 * The QR encoder lives in @claudio/ui (lib/qr.ts). The app's default caps the version at 10, which
 * holds 213 bytes: a tunnel's address is about 30, and a code that small still scans off a phone's
 * screen at the size Settings draws it. A longer text (a Collaborators invite) asks for more.
 */
import { encodeQr as encode, type QrMatrix } from '@claudio/ui/lib/qr';

export { formatBits, reedSolomon, type QrMatrix } from '@claudio/ui/lib/qr';

/** The version the app draws up to unless a caller asks for a bigger code. */
export const DEFAULT_MAX_VERSION = 10;

export function encodeQr(text: string, maxVersion: number = DEFAULT_MAX_VERSION): QrMatrix | null {
  return encode(text, maxVersion);
}
