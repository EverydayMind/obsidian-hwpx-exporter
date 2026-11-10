function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Reject conflicting directory identities before JSZip interprets the entries.
 * This is not a decompression or aggregate memory limit. */
export function checkZipDirectoryIdentity(bytes: Uint8Array): Uint8Array[] {
  const compressedDirectories: Uint8Array[] = [];
  if (bytes.length < 22) throw new Error('missing ZIP end record');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('missing or ambiguous ZIP end record');
  // JSZip chooses the last EOCD signature, including one embedded in a ZIP
  // comment. Refuse ambiguity instead of checking a different directory.
  for (let i = bytes.length - 4; i > end; i--) {
    if (v.getUint32(i, true) === 0x06054b50) throw new Error('ambiguous ZIP end record');
  }
  let count = v.getUint16(end + 10, true), offset = v.getUint32(end + 16, true), size = v.getUint32(end + 12, true);
  let directoryEnd = end;
  const read64 = (at: number, limit: number): number => {
    if (at < 0 || at + 8 > limit) throw new Error('invalid ZIP64 field');
    const n = v.getBigUint64(at, true);
    // JSZip uses signed 32-bit arithmetic to read ZIP64 numbers.
    if (n > 0x7fffffffn) throw new Error('unsupported ZIP64 value');
    return Number(n);
  };
  const zip64 = v.getUint16(end + 4, true) === 0xffff || v.getUint16(end + 6, true) === 0xffff ||
    v.getUint16(end + 8, true) === 0xffff || count === 0xffff || offset === 0xffffffff || size === 0xffffffff;
  if (zip64) {
    const locator = end - 20;
    if (locator < 0 || v.getUint32(locator, true) !== 0x07064b50 || v.getUint32(locator + 4, true) !== 0 || v.getUint32(locator + 16, true) !== 1) throw new Error('invalid ZIP64 locator');
    // JSZip searches backwards for this signature instead of requiring it at
    // the standard location; refuse a later, differently interpreted locator.
    for (let i = end - 4; i > locator; i--) {
      if (v.getUint32(i, true) === 0x07064b50) throw new Error('ambiguous ZIP64 locator');
    }
    const relativeEnd = read64(locator + 8, end);
    let zipEnd = relativeEnd;
    if (zipEnd + 56 > locator || v.getUint32(zipEnd, true) !== 0x06064b50) {
      zipEnd = -1;
      for (let i = locator - 56; i >= 0; i--) {
        if (v.getUint32(i, true) === 0x06064b50) { zipEnd = i; break; }
      }
    }
    if (zipEnd < 0 || zipEnd + 56 > locator) throw new Error('invalid ZIP64 end record');
    for (let i = zipEnd + 1; i <= bytes.length - 4; i++) {
      if (v.getUint32(i, true) === 0x06064b50) throw new Error('ambiguous ZIP64 end record');
    }
    const recordSize = read64(zipEnd + 4, locator);
    if (recordSize < 44 || zipEnd + 12 + recordSize !== locator || v.getUint32(zipEnd + 16, true) !== 0 || v.getUint32(zipEnd + 20, true) !== 0) throw new Error('invalid ZIP64 end record');
    count = read64(zipEnd + 32, locator);
    if (read64(zipEnd + 24, locator) !== count) throw new Error('split ZIP64 directory');
    size = read64(zipEnd + 40, locator);
    offset = read64(zipEnd + 48, locator);
    directoryEnd = zipEnd;
  }
  const base = directoryEnd - offset - size;
  if (base < 0) throw new Error('invalid ZIP central offset');
  const centralStart = offset + base;
  let p = centralStart;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directoryEnd || v.getUint32(p, true) !== 0x02014b50) throw new Error('invalid ZIP central directory');
    const nameLength = v.getUint16(p + 28, true), extraLength = v.getUint16(p + 30, true), commentLength = v.getUint16(p + 32, true);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd) throw new Error('invalid ZIP central entry');
    const nameStart = p + 46;
    let localOffset = v.getUint32(p + 42, true);
    if (localOffset === 0xffffffff) {
      let field = nameStart + nameLength, fieldEnd = field + extraLength, found = false;
      while (field < fieldEnd) {
        if (field + 4 > fieldEnd) throw new Error('invalid ZIP extra field');
        const id = v.getUint16(field, true), n = v.getUint16(field + 2, true);
        field += 4;
        if (field + n > fieldEnd) throw new Error('invalid ZIP extra field');
        if (id === 1) {
          if (found) throw new Error('ambiguous ZIP64 field');
          found = true;
          let value = field;
          if (v.getUint32(p + 24, true) === 0xffffffff) { read64(value, field + n); value += 8; }
          if (v.getUint32(p + 20, true) === 0xffffffff) { read64(value, field + n); value += 8; }
          localOffset = read64(value, field + n);
        }
        field += n;
      }
      if (!found) throw new Error('missing ZIP64 offset');
    }
    const local = localOffset + base;
    if (local + 30 > centralStart || v.getUint32(local, true) !== 0x04034b50) throw new Error('invalid ZIP local entry');
    const localNameLength = v.getUint16(local + 26, true), localExtraLength = v.getUint16(local + 28, true);
    if (local + 30 + localNameLength + localExtraLength > centralStart || localNameLength !== nameLength ||
      bytes.subarray(nameStart, nameStart + nameLength).some((b, index) => b !== bytes[local + 30 + index])) throw new Error('ZIP entry name mismatch');
    const isDirectory = nameLength > 0 && bytes[nameStart + nameLength - 1] === 0x2f;
    // JSZip discards directory data when it constructs its in-memory package.
    // Reject a declared nonempty directory before that irreversible conversion,
    // including directory flags that JSZip treats independently of the name.
    const attributes = v.getUint32(p + 38, true);
    const unixDirectory = (v.getUint16(p + 4, true) >>> 8) === 3 && ((attributes >>> 16) & 0x4000) !== 0;
    if (isDirectory || (attributes & 0x10) !== 0 || unixDirectory) {
      let uncompressed = v.getUint32(p + 24, true);
      let compressed = v.getUint32(p + 20, true);
      if (uncompressed === 0xffffffff || compressed === 0xffffffff) {
        let field = nameStart + nameLength;
        const fieldEnd = field + extraLength;
        let found = false;
        while (field < fieldEnd) {
          if (field + 4 > fieldEnd) throw new Error('invalid ZIP extra field');
          const id = v.getUint16(field, true), n = v.getUint16(field + 2, true);
          field += 4;
          if (field + n > fieldEnd) throw new Error('invalid ZIP extra field');
          if (id === 1) {
            if (found) throw new Error('ambiguous ZIP64 field');
            found = true;
            let value = field;
            if (uncompressed === 0xffffffff) { uncompressed = read64(value, field + n); value += 8; }
            if (compressed === 0xffffffff) compressed = read64(value, field + n);
          }
          field += n;
        }
        if (!found) throw new Error('missing ZIP64 size');
      }
      if (uncompressed !== 0) throw new Error('ZIP directory contains data');
      const start = local + 30 + localNameLength + localExtraLength;
      if (compressed > centralStart - start) throw new Error('invalid ZIP directory data');
      const method = v.getUint16(p + 10, true);
      if (method === 0) {
        if (compressed !== 0) throw new Error('ZIP directory contains data');
      } else if (method === 8) {
        compressedDirectories.push(bytes.subarray(start, start + compressed));
      } else {
        throw new Error('unsupported ZIP directory compression');
      }
    }
    if ((v.getUint16(p + 8, true) & 0x0800) === 0) {
      let extra = nameStart + nameLength;
      const limit = extra + extraLength;
      while (extra < limit) {
        if (extra + 4 > limit) throw new Error('invalid ZIP extra field');
        const id = v.getUint16(extra, true), n = v.getUint16(extra + 2, true);
        extra += 4;
        if (extra + n > limit) throw new Error('invalid ZIP extra field');
        if (id === 0x7075 && n >= 5 && bytes[extra] === 1 &&
          v.getUint32(extra + 1, true) === crc32(bytes.subarray(nameStart, nameStart + nameLength))) {
          const unicode = bytes.subarray(extra + 5, extra + n);
          if ((unicode.length > 0 && unicode[unicode.length - 1] === 0x2f) !== isDirectory) throw new Error('ZIP Unicode directory mismatch');
        }
        extra += n;
      }
    }
    p = next;
  }
  if (p !== directoryEnd) throw new Error('ZIP central entry count mismatch');
  return compressedDirectories;
}
