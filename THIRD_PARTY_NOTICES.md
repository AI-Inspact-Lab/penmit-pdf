# Third-party notices

Penmit PDF includes the following software. Each keeps its own license; the full texts
ship next to the files.

| Component | Used for | License | License text |
| --- | --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js) 6.2.108 (legacy build) | Rendering PDFs | Apache-2.0, Mozilla Foundation | `web/vendor/pdfjs/LICENSE` |
| ↳ CMaps | Rendering CJK text | Adobe, BSD-style | `web/vendor/pdfjs/cmaps/LICENSE` |
| ↳ Standard fonts (Foxit, Liberation) | Fonts that PDFs reference without embedding | BSD-style (PDFium), SIL Open Font License 1.1 | `web/vendor/pdfjs/standard_fonts/LICENSE_*` |
| ↳ OpenJPEG, JBIG2 (PDFium), qcms | Decoding JPEG 2000 and JBIG2 images, colour management | BSD-2-Clause, BSD-style, MIT | `web/vendor/pdfjs/wasm/LICENSE_*` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 | Writing handwriting into exported PDFs | MIT, Andrew Dillon | `web/vendor/pdf-lib/LICENSE.md` |
| Penmit Sans: a subset of [Pretendard](https://github.com/orioncactus/pretendard) 1.3.9 (variable) | Interface font: Latin and the 2,350 common Hangul syllables | SIL Open Font License 1.1, Kil Hyung-jin; includes Source Han Sans (Adobe) and Inter (Rasmus Andersson) | `web/vendor/penmit-sans/LICENSE.txt` |
| [Electron](https://www.electronjs.org/) | Windows and Linux apps (downloaded at build time) | MIT | in the built app |
| [Capacitor](https://capacitorjs.com/) | Android app (downloaded at build time) | MIT | in the built app |

The PDF.js and pdf-lib files under `web/vendor/` are copied unmodified from the `pdfjs-dist`
and `pdf-lib` npm packages. Penmit Sans is Pretendard cut down to the characters the app
needs; as the Open Font License requires for modified versions, it is renamed so it does not
use the reserved font names 'Pretendard', 'Source' or 'Inter'. Its copyright notices and license are kept.
