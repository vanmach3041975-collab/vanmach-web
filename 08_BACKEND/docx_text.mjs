import zlib from 'node:zlib';

const bad = () => { throw Object.assign(new Error('Tệp Word không hợp lệ hoặc quá lớn.'), {status:400}); };
const maxArchive = 256 * 1024;
const maxXml = 128 * 1024;
const maxTextBytes = 12000;
const entryName = 'word/document.xml';

function decodeEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : '';
    }
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()] ?? whole;
  });
}

// Read only the central-directory entry for the main document. Never unpack
// arbitrary paths or embedded media, and bound both compressed and inflated data.
export function extractDocxText(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > maxArchive) bad();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) bad();
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  let offset = bytes.readUInt32LE(eocd + 16);
  if (count > 1024 || offset + centralSize !== eocd) bad();
  let target;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) bad();
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) bad();
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      if (target) bad();
      target = {
        flags:bytes.readUInt16LE(offset + 8), method:bytes.readUInt16LE(offset + 10),
        crc:bytes.readUInt32LE(offset + 16), compressed:bytes.readUInt32LE(offset + 20),
        inflated:bytes.readUInt32LE(offset + 24), local:bytes.readUInt32LE(offset + 42),
      };
    }
    offset = next;
  }
  if (offset !== eocd || !target || target.flags & 1 || ![0,8].includes(target.method) ||
      target.compressed > maxArchive || target.inflated > maxXml || target.inflated === 0) bad();
  const local = target.local;
  if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 8) !== target.method) bad();
  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  if (start + target.compressed > bytes.length) bad();
  let xml;
  try {
    const compressed = bytes.subarray(start, start + target.compressed);
    xml = target.method === 8 ? zlib.inflateRawSync(compressed, {maxOutputLength:maxXml}) : compressed;
  } catch { bad(); }
  if (xml.length !== target.inflated || !xml.toString('utf8', 0, 1000).includes('document')) bad();
  const source = xml.toString('utf8');
  const paragraphs = [];
  for (const paragraph of source.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const parts = [];
    for (const run of paragraph[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) parts.push(decodeEntities(run[1]));
    const line = parts.join('').replace(/[\u0000-\u001f]+/g, ' ').trim();
    if (line) paragraphs.push(line);
  }
  const text = paragraphs.join('\n');
  if (Buffer.byteLength(text, 'utf8') < 30 || Buffer.byteLength(text, 'utf8') > maxTextBytes) bad();
  return text;
}
