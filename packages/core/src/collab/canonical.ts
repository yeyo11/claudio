/**
 * RFC 8785, JSON Canonicalization Scheme: the bytes every roster signature and hash is computed
 * over, so two installs that hold the same version agree on its hash whatever order their JSON
 * happened to be written in.
 *
 * ECMAScript's own `JSON.stringify` already serialises strings and numbers the way RFC 8785
 * requires (§3.2.2.2, §3.2.2.3); what it leaves to us is the property order (UTF-16 code units,
 * which is what `Array.prototype.sort` compares) and refusing what JSON cannot carry.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} has no JSON form`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`${path}: a ${typeof value} has no JSON form`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => {
      // JSON.stringify turns a hole into null; a signed document must not change shape silently.
      if (item === undefined) throw new TypeError(`${path}[${index}]: undefined has no JSON form`);
      return serialize(item, `${path}[${index}]`);
    }).join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${path}: only plain objects are canonicalised`);
  }
  const record = value as Record<string, unknown>;
  // An absent optional field and one set to undefined are the same document, as in JSON.stringify.
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`).join(',')}}`;
}
