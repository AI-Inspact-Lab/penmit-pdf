// Prints the annotations of a PDF as JSON: node tests/count_annotations.mjs file.pdf
import { PDFDocument, PDFName } from "../web/vendor/pdf-lib/pdf-lib.esm.min.js";
import { readFileSync } from "node:fs";

const doc = await PDFDocument.load(readFileSync(process.argv[2]));
const out = [];
doc.getPages().forEach((pg, i) => {
  const annots = pg.node.Annots();
  if (!annots) return;
  for (const ref of annots.asArray()) {
    const a = doc.context.lookup(ref);
    out.push({ page: i, sub: a.get(PDFName.of("Subtype")).toString(), ap: !!a.get(PDFName.of("AP")), nm: a.get(PDFName.of("NM")).toString().slice(0, 12), ca: a.get(PDFName.of("CA"))?.toString() });
  }
});
console.log(JSON.stringify(out));
