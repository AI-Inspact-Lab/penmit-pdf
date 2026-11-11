// Writes tests/out/test.pdf: six pages, one landscape (4) and one rotated 90 degrees (5).
import { PDFDocument, StandardFonts, rgb, degrees } from "../web/vendor/pdf-lib/pdf-lib.esm.min.js";
import { mkdirSync, writeFileSync } from "node:fs";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 6; i++) {
  const landscape = i === 4;
  const page = doc.addPage(landscape ? [792, 612] : [612, 792]);
  if (i === 5) page.setRotation(degrees(90));
  const { width, height } = page.getSize();
  page.drawText(`Test page ${i}${i === 5 ? " (rotated 90)" : ""}${landscape ? " (landscape)" : ""}`, { x: 60, y: height - 80, size: 28, font, color: rgb(0.1, 0.1, 0.2) });
  for (let l = 0; l < 18; l++) page.drawText("The quick brown fox jumps over the lazy dog. 0123456789", { x: 60, y: height - 140 - l * 26, size: 13, font, color: rgb(0.25, 0.25, 0.3) });
  page.drawRectangle({ x: 60, y: 80, width: width - 120, height: 60, borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 2 });
}
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL("./out/test.pdf", import.meta.url), await doc.save());

// tests/out/big.pdf: one page plus 5 MB of unused random data, to exercise large uploads.
const big = await PDFDocument.create();
const bigFont = await big.embedFont(StandardFonts.Helvetica);
big.addPage([612, 792]).drawText("Big file", { x: 60, y: 700, size: 28, font: bigFont });
const noise = new Uint8Array(5 * 1024 * 1024);
for (let i = 0; i < noise.length; i += 65536) crypto.getRandomValues(noise.subarray(i, i + 65536));
big.context.register(big.context.stream(noise));
writeFileSync(new URL("./out/big.pdf", import.meta.url), await big.save({ useObjectStreams: false }));
console.log("tests/out/test.pdf and tests/out/big.pdf written");
