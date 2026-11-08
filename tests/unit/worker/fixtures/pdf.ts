// Test fixtures built at run time: no binary files are committed. All content is synthetic.

export interface BuildPdfOptions {
  /** One entry per page; each entry is the lines of text drawn on that page. Empty array = no text. */
  pages: string[][];
  /** Add an /Encrypt dictionary to the trailer (a hand-built Standard handler entry). */
  encrypt?: boolean;
}

function escapePdfString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Build a minimal valid PDF 1.4 with Helvetica text and a correct cross-reference table. */
export function buildPdf(options: BuildPdfOptions): Uint8Array {
  const { pages, encrypt = false } = options;
  const objects: string[] = [];
  // 1 catalog, 2 pages, 3 font, then per page: page object and content stream.
  const firstPageObj = 4;
  const kids = pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((lines, i) => {
    const contentObj = firstPageObj + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    const drawing =
      lines.length === 0
        ? ''
        : 'BT /F1 12 Tf 72 720 Td 16 TL ' +
          lines.map((line) => `(${escapePdfString(line)}) Tj T*`).join(' ') +
          ' ET';
    objects.push(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`);
  });
  if (encrypt) {
    const hex32 = '00'.repeat(32);
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >>`, // fake key material
    );
  }

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const encryptEntry = encrypt ? ` /Encrypt ${objects.length} 0 R /ID [<00><00>]` : '';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptEntry} >>\n`;
  out += `startxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------------------------
// A PDF that is REALLY encrypted (standard security handler, V1/R2, RC4 40-bit) with the empty user
// password, so pdf.js opens it without asking for a password. The parser accepts such files; the
// ingestion policy must still refuse them. All keys here are derived from fixed synthetic values.
// ---------------------------------------------------------------------------------------------
import { createHash } from 'node:crypto';

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (state[i] as number) + (key[i % key.length] as number)) & 255;
    const tmp = state[i] as number;
    state[i] = state[j] as number;
    state[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n += 1) {
    a = (a + 1) & 255;
    b = (b + (state[a] as number)) & 255;
    const tmp = state[a] as number;
    state[a] = state[b] as number;
    state[b] = tmp;
    out[n] =
      (data[n] as number) ^ (state[((state[a] as number) + (state[b] as number)) & 255] as number);
  }
  return out;
}

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export interface EncryptedPdfOptions {
  /** One entry per line of text on the single page. */
  lines: string[];
  /** The text written in the trailer for the /Encrypt key; defaults to `/Encrypt`. */
  encryptKeyName?: string;
}

/** A one-page PDF encrypted with the empty user password. The text only appears after decryption. */
export function buildEmptyPasswordEncryptedPdf(options: EncryptedPdfOptions): Uint8Array {
  const { lines, encryptKeyName = '/Encrypt' } = options;
  const id = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const p = -4;
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, p, true);
  // Algorithm 3 (O, R2): the owner password is empty, so it is the padding string itself.
  const oKey = md5(PAD).slice(0, 5);
  const o = rc4(oKey, PAD);
  // Algorithm 2 (file key, R2) and Algorithm 4 (U, R2).
  const fileKey = md5(PAD, o, pBytes, id).slice(0, 5);
  const u = rc4(fileKey, PAD);
  const objectKey = (objectNumber: number): Uint8Array => {
    const suffix = Uint8Array.from([
      objectNumber & 255,
      (objectNumber >> 8) & 255,
      (objectNumber >> 16) & 255,
      0,
      0,
    ]);
    return md5(fileKey, suffix).slice(0, 10);
  };

  const drawing =
    'BT /F1 12 Tf 72 720 Td 16 TL ' +
    lines.map((line) => `(${escapePdfString(line)}) Tj T*`).join(' ') +
    ' ET';
  const encryptedDrawing = latin1(rc4(objectKey(5), new TextEncoder().encode(drawing)));

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${encryptedDrawing.length} >>\nstream\n${encryptedDrawing}\nendstream`,
    `<< /Filter /Standard /V 1 /R 2 /O <${hex(o)}> /U <${hex(u)}> /P ${p} >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryptKeyName} ${objects.length} 0 R /ID [<${hex(id)}> <${hex(id)}>] >>\n`;
  out += `startxref\n${xrefAt}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(out, 'latin1'));
}
