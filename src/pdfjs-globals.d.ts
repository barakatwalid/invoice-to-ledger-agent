// pdfjs-dist 6.3.289 is published against a newer DOM declaration set than
// TypeScript 5.8.3. This is the missing standard alias used only in its .d.ts files.
type ImageDataArray = Uint8ClampedArray;

declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
