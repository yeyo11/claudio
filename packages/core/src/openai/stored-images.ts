import { imageDigest } from './conversation-key.ts';
import type { InputImage, InputItem, InputItemOf } from './responses-wire.ts';
import type { ImageRef } from './wire.ts';

/**
 * The images of a stored response's input (docs/openai-compatible-api.md, "Images in the stored
 * input"). A row keeps a reference, never the bytes: copying up to 5 MB of base64 into every row,
 * and parsing it on each lookup, would buy nothing, since the turn saved the bytes as an upload.
 * `GET /v1/responses/:id/input_items` reads them back from the upload, so a client that rebuilds its
 * history from that list and sends it again gets the same image, and the same conversation key.
 */

/**
 * The longest image URL a row keeps as it is: a signed link is a few kilobytes at most. A longer one
 * is kept as a marker and never read back: its key was taken from the URL, which the row no longer has
 */
export const STORED_IMAGE_URL_MAX = 32 * 1024;

/** An image part as the request carried it: the bytes or the link, for the turn */
export type RequestImage = { type: 'input_image'; detail: string; image: ImageRef };
export type RequestInputItem = InputItemOf<RequestImage>;

/** Where a stored image's bytes are: an upload (null when none could be named), the link itself, or neither (a long link) */
export type StoredImage =
  | { kind: 'url'; url: string }
  | { kind: 'data'; mediaType: string; sizeBytes: number; digest: string; upload: string | null }
  | { kind: 'long-url'; origin: string; length: number };
export type StoredImagePart = { type: 'input_image'; detail: string; stored: StoredImage };
/** A row's input item. Rows written before references kept an `image_url` marker, listed as it is */
export type StoredInputItem = InputItemOf<StoredImagePart | InputImage>;

function mapImages<A extends { type: 'input_image' }, B>(items: readonly InputItemOf<A>[], f: (part: A) => B): InputItemOf<B>[] {
  return items.map((item): InputItemOf<B> => {
    if (item.type !== 'message' || item.role === 'assistant') return item;
    const content = item.content.map((part) => (part.type === 'input_text' ? { type: 'input_text' as const, text: part.text } : f(part)));
    return { ...item, role: item.role, content };
  });
}

/** The input as a row keeps it. `uploadOf` names the upload that holds a data URL image's bytes (by `imageDigest`), if any. */
export function storedInputItems(items: readonly RequestInputItem[], uploadOf: (digest: string) => string | null): StoredInputItem[] {
  return mapImages(items, ({ detail, image }): StoredImagePart => {
    if (image.kind === 'url') {
      const stored: StoredImage = image.url.length <= STORED_IMAGE_URL_MAX ? { kind: 'url', url: image.url } : { kind: 'long-url', origin: new URL(image.url).origin, length: image.url.length };
      return { type: 'input_image', detail, stored };
    }
    const digest = imageDigest(image);
    return { type: 'input_image', detail, stored: { kind: 'data', mediaType: image.mediaType, sizeBytes: image.sizeBytes, digest, upload: uploadOf(digest) } };
  });
}

/** Every upload a stored input names, with the digest of its image: how a later row finds one again. */
export function storedUploads(items: readonly StoredInputItem[]): Array<{ digest: string; upload: string }> {
  return items.flatMap((item) =>
    item.type === 'message' && item.role !== 'assistant'
      ? item.content.flatMap((part) => (part.type === 'input_image' && 'stored' in part && part.stored.kind === 'data' && part.stored.upload !== null ? [{ digest: part.stored.digest, upload: part.stored.upload }] : []))
      : [],
  );
}

/**
 * The input as `GET /v1/responses/:id/input_items` lists it: each data URL image read back from its
 * upload. An upload that is gone (or was never named) leaves a marker in its place, a data URL with
 * the type and size and no payload; a long link is always its marker, its origin with how long it was.
 */
export function listedInputItems(items: readonly StoredInputItem[], read: (upload: string) => { bytes: Buffer; mediaType: string } | null): InputItem[] {
  return mapImages(items, (part): InputImage => {
    if (!('stored' in part)) return part;
    const { detail, stored } = part;
    if (stored.kind === 'url') return { type: 'input_image', image_url: stored.url, detail };
    if (stored.kind === 'long-url') return { type: 'input_image', image_url: `${stored.origin}/?claudio-omitted-chars=${String(stored.length)}`, detail };
    const found = stored.upload === null ? null : read(stored.upload);
    const url = found ? `data:${stored.mediaType};base64,${found.bytes.toString('base64')}` : `data:${stored.mediaType};claudio-omitted-bytes=${String(stored.sizeBytes)},`;
    return { type: 'input_image', image_url: url, detail };
  });
}
