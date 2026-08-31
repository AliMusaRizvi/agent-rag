import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { createRequire } from 'module';
import { config } from '../config.js';
import { addDocuments } from '../vectorstore.js';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');
const { PDFParse } = require('pdf-parse');

// Fixed from the original: multer.memoryStorage() only ever populates
// req.file.buffer, never req.file.path — the old handler read .path for
// every real file type and threw on all of them. This version works off
// the buffer throughout, sniffs the real file type from its magic bytes
// instead of trusting the client-supplied mimetype, and caps both the
// upload size and the extracted text length before anything reaches the
// embedder.

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
});

const MAX_EXTRACTED_CHARS = 200_000;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

export async function uploadHandler(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const { buffer, originalname } = req.file;
  const sniffed = await fileTypeFromBuffer(buffer);
  const effectiveMime = sniffed?.mime || (looksLikePlainText(buffer) ? 'text/plain' : null);

  if (!effectiveMime || !ALLOWED_MIME.has(effectiveMime)) {
    return res.status(415).json({ error: 'Unsupported or unrecognized file type. Upload a PDF, DOCX, or plain text file.' });
  }

  let textContent;
  try {
    if (effectiveMime === 'application/pdf') {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        textContent = result.text;
      } finally {
        await parser.destroy();
      }
    } else if (effectiveMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer });
      textContent = result.value;
    } else {
      textContent = buffer.toString('utf8');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to extract text from upload');
    return res.status(422).json({ error: 'Could not read this file — it may be corrupted or password-protected.' });
  }

  textContent = textContent.slice(0, MAX_EXTRACTED_CHARS).trim();
  if (!textContent) {
    return res.status(422).json({ error: 'No extractable text found in this file.' });
  }

  // Private to the uploading session (tenantId), never merged into the
  // shared global corpus — one user's upload must not answer another
  // user's question (see the audit's cross-tenant-leak finding).
  const count = await addDocuments(
    [{ content: textContent, metadata: { source: originalname, type: 'uploaded' } }],
    { tenantId: req.sessionId },
  );

  res.json({ success: true, filename: originalname, chunksIndexed: count });
}

function looksLikePlainText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable++;
  }
  return sample.length > 0 && printable / sample.length > 0.95;
}
