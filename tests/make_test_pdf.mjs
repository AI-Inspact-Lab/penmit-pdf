// Writes tests/out/test.pdf: six pages, one landscape (4) and one rotated 90 degrees (5), with a
// table of contents ("Part A" -> page 3, "Part B" -> page 5, which has "Part B.1" -> page 6).
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFHexString } from "../web/vendor/pdf-lib/pdf-lib.esm.min.js";
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
{
  const ctx = doc.context;
  const pages = doc.getPages();
  const dest = (i) => [pages[i].ref, PDFName.of("Fit")];
  const outlinesRef = ctx.nextRef();
  const aRef = ctx.nextRef(), bRef = ctx.nextRef(), b1Ref = ctx.nextRef();
  ctx.assign(aRef, ctx.obj({ Title: PDFHexString.fromText("Part A"), Parent: outlinesRef, Next: bRef, Dest: dest(2) }));
  ctx.assign(bRef, ctx.obj({ Title: PDFHexString.fromText("Part B"), Parent: outlinesRef, Prev: aRef, First: b1Ref, Last: b1Ref, Count: 1, Dest: dest(4) }));
  ctx.assign(b1Ref, ctx.obj({ Title: PDFHexString.fromText("Part B.1"), Parent: bRef, Dest: dest(5) }));
  ctx.assign(outlinesRef, ctx.obj({ Type: "Outlines", First: aRef, Last: bRef, Count: 3 }));
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
}
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL("./out/test.pdf", import.meta.url), await doc.save());

// tests/out/four.pdf: four portrait pages (in the cover layout: 1, 2+3, 4).
const four = await PDFDocument.create();
const fourFont = await four.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 4; i++) four.addPage([595, 842]).drawText(`Page ${i} of 4`, { x: 60, y: 760, size: 28, font: fourFont });
writeFileSync(new URL("./out/four.pdf", import.meta.url), await four.save());

// tests/out/big.pdf: one page plus 5 MB of unused random data, to exercise large uploads.
const big = await PDFDocument.create();
const bigFont = await big.embedFont(StandardFonts.Helvetica);
big.addPage([612, 792]).drawText("Big file", { x: 60, y: 700, size: 28, font: bigFont });
const noise = new Uint8Array(5 * 1024 * 1024);
for (let i = 0; i < noise.length; i += 65536) crypto.getRandomValues(noise.subarray(i, i + 65536));
big.context.register(big.context.stream(noise));
writeFileSync(new URL("./out/big.pdf", import.meta.url), await big.save({ useObjectStreams: false }));
console.log("tests/out/test.pdf and tests/out/big.pdf written");
