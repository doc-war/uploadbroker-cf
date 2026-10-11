const textTypes = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', yaml: 'application/yaml', yml: 'text/yaml',
  toml: 'application/toml', ini: 'text/x-ini', conf: 'text/x-config', sh: 'text/x-shellscript', bash: 'text/x-bash',
  go: 'text/x-go', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', java: 'text/x-java',
  c: 'text/x-c', h: 'text/x-ch', cpp: 'text/x-c++', hpp: 'text/x-cpp-header', rs: 'text/x-rust',
  rb: 'text/x-ruby', php: 'text/x-php', sql: 'text/x-sql', csv: 'text/csv', css: 'text/css'
};
const binaryTypes = [
  ['image/png', 'png', 'image'], ['image/jpeg', 'jpg', 'image'], ['image/webp', 'webp', 'image'],
  ['audio/mpeg', 'mp3', 'audio'], ['audio/wav', 'wav', 'audio'], ['video/mp4', 'mp4', 'video'],
  ['video/webm', 'webm', 'video'], ['application/pdf', 'pdf', 'document'],
  ['application/zip', 'zip', 'archive'], ['application/x-7z-compressed', '7z', 'archive'], ['application/x-rar-compressed', 'rar', 'archive']
];
const known = Object.fromEntries([...binaryTypes.map(([mime, ext]) => [ext, mime]), ...Object.entries(textTypes), ['m4a', 'audio/mp4'], ['aac', 'audio/aac']]);
export function detect(filename, bytes) {
  if (!bytes.length) return null;
  const starts = signature => signature.every((b, i) => bytes[i] === b);
  const ascii = (offset, value) => startsAt(bytes, offset, value);
  let mime;
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) mime = 'image/png';
  else if (starts([255, 216, 255])) mime = 'image/jpeg';
  else if (ascii(0, 'RIFF') && ascii(8, 'WEBPVP')) mime = 'image/webp';
  else if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) mime = 'audio/wav';
  else if (starts([55, 122, 188, 175, 39, 28])) mime = 'application/x-7z-compressed';
  else if (starts([82, 97, 114, 33, 26, 7])) mime = 'application/x-rar-compressed';
  else if (ascii(0, '%PDF-')) mime = 'application/pdf';
  else if (starts([80, 75, 3, 4])) mime = 'application/zip';
  else if (ascii(0, 'ID3')) mime = 'audio/mpeg';
  else if (starts([26, 69, 223, 163])) mime = 'video/webm';
  else if (bytes.length >= 12 && ascii(4, 'ftyp')) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 12 && size % 4 === 0 && size <= bytes.length) {
      for (let i = 8; i < size; i += 4) if (i !== 12 && ascii(i, 'mp4')) mime = 'video/mp4';
    }
  }
  if (mime) {
    const [, ext, category] = binaryTypes.find(row => row[0] === mime);
    return { mimeType: mime, extension: `.${ext}`, category };
  }
  // Match Go's text fallback after rejecting active content and unsupported signatures.
  const text = new TextDecoder().decode(bytes).replace(/^[\t\n\f\r ]+/, '');
  if (/^(?:<(?:!DOCTYPE HTML|HTML|HEAD|SCRIPT|IFRAME|H1|DIV|FONT|TABLE|A|STYLE|TITLE|B|BODY|BR|P)(?:[\s>])|<!--|<\?xml)/i.test(text)) return null;
  if (bytes.some(b => b <= 8 || b === 11 || (b >= 14 && b <= 26) || (b >= 28 && b <= 31))) return null;
  const ext = filename.split('.').length > 1 ? filename.split('.').pop().toLowerCase() : '';
  if (['html', 'htm', 'svg', 'xml'].includes(ext)) return null;
  return { mimeType: textTypes[ext] ?? 'text/plain', extension: `.${textTypes[ext] ? ext : 'txt'}`, category: 'document' };
}
function startsAt(bytes, offset, text) {
  return [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
}
export function validateExtension(filename, mime) {
  // Go uses a case-sensitive lookup here; preserve it for client compatibility.
  const ext = filename.includes('.') ? filename.split('.').pop() : '';
  return !known[ext] || known[ext] === mime;
}
