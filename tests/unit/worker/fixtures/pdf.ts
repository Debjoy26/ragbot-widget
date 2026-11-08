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
