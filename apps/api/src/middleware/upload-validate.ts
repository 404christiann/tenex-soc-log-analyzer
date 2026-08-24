import multer from "multer";
import { looksLikeExpectedFormat } from "../parser/parse-log";

/**
 * Upload validation (DECISIONS.md §5, §9, §14a — must-have, in this exact
 * order, before ANYTHING is persisted to Storage or the DB):
 *   1. Extension allowlist (.log/.txt, case-insensitive)
 *   2. Size cap (10MB)
 *   3. Filename sanitization (reject path traversal / control characters)
 *   4. Magic-byte / content checks: known binary signatures, null bytes,
 *      UTF-8 validity within a 2% invalid-byte threshold (DECISIONS.md
 *      §14b), and `looksLikeExpectedFormat()` on the first non-blank line.
 *
 * All four are exposed as small, independently unit-testable pure functions
 * plus one `validateUpload()` that runs them in the locked order and
 * short-circuits on the first failure. `uploadMulter` wires steps 1-2 in
 * as multer config (memory storage — nothing hits disk before validation
 * passes) so an oversized or wrong-extension file never even finishes
 * buffering into a `Buffer` for the rest of this module to inspect.
 */

/** Multipart field name for the uploaded file — documented here as the single source of truth. */
export const UPLOAD_FIELD_NAME = "file";

export const ALLOWED_EXTENSIONS = [".log", ".txt"];

/** DECISIONS.md §5/§9: 10MB size cap. */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** DECISIONS.md §10 must-have: cap parsed rows so a pathological file can't stall the synchronous pipeline. Enforced by the route AFTER parsing, not here. */
export const MAX_PARSED_EVENTS = 50_000;

export interface Rejection {
  status: number;
  message: string;
}

function reject(status: number, message: string): Rejection {
  return { status, message };
}

// ---------------------------------------------------------------------------
// 1. Extension allowlist
// ---------------------------------------------------------------------------

export function checkExtension(originalFilename: string): Rejection | null {
  const lower = originalFilename.toLowerCase();
  const allowed = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  if (!allowed) {
    return reject(
      400,
      `Unsupported file extension — only ${ALLOWED_EXTENSIONS.join(", ")} files are accepted.`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Size cap
// ---------------------------------------------------------------------------

/**
 * Explicit, independently unit-testable size check. Redundant in production
 * with multer's `limits.fileSize` (which stops accepting bytes mid-stream,
 * so an oversized upload never fully buffers) — kept as defense-in-depth and
 * so "oversized" is testable as a pure function without spinning up multer.
 */
export function checkFileSize(buffer: Buffer): Rejection | null {
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    return reject(413, `File exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB upload size limit.`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Filename sanitization
// ---------------------------------------------------------------------------

/** No path separators, no `..` traversal segments, no control characters (including null bytes). */
const UNSAFE_FILENAME_PATTERN = /[/\\]|\.\.|[\x00-\x1f]/;

export function checkFilename(originalFilename: string): Rejection | null {
  if (!originalFilename || originalFilename.trim().length === 0) {
    return reject(400, "Filename is required.");
  }
  if (UNSAFE_FILENAME_PATTERN.test(originalFilename)) {
    return reject(400, "Filename contains disallowed path-traversal or control characters.");
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Magic-byte / content checks
// ---------------------------------------------------------------------------

/** Known binary file signatures to reject at the start of the buffer (DECISIONS.md §14a). */
const BINARY_SIGNATURES: { name: string; bytes: number[] }[] = [
  { name: "PDF", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { name: "ZIP/Office (zip, docx, xlsx, ...)", bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK\x03\x04
  { name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { name: "ELF", bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

export function checkBinarySignature(buffer: Buffer): Rejection | null {
  for (const sig of BINARY_SIGNATURES) {
    if (buffer.length >= sig.bytes.length && sig.bytes.every((byte, i) => buffer[i] === byte)) {
      return reject(400, `File content looks like a binary ${sig.name} file, not a text log — rejected.`);
    }
  }
  return null;
}

export function checkNullBytes(buffer: Buffer): Rejection | null {
  if (buffer.includes(0x00)) {
    return reject(400, "File contains null bytes — not a valid text log file.");
  }
  return null;
}

export interface Utf8DecodeResult {
  ok: boolean;
  text?: string;
  rejection?: Rejection;
}

/**
 * DECISIONS.md §14b: threshold, not zero-tolerance. Decodes leniently
 * (`fatal: false` substitutes U+FFFD for each invalid byte sequence instead
 * of throwing) and rejects only if replacement characters make up more than
 * `MAX_INVALID_UTF8_RATIO` of the decoded text. A handful of corrupted bytes
 * in an otherwise-valid text file (e.g. `examples/malformed-edge-cases.log`,
 * built to exercise the parser's per-line graceful degradation) stays well
 * under the threshold, while genuine binary files (PDFs, images, etc.) are
 * mostly non-text bytes and blow past it easily — preserving the real
 * security intent (reject disguised binaries) without rejecting a mostly-
 * valid text file over a few deliberately-corrupted bytes.
 */
const MAX_INVALID_UTF8_RATIO = 0.02;

export function decodeUtf8WithThreshold(buffer: Buffer): Utf8DecodeResult {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (text.length === 0) {
    return { ok: true, text };
  }
  let replacementCount = 0;
  for (const char of text) {
    if (char === "�") replacementCount++;
  }
  const invalidRatio = replacementCount / text.length;
  if (invalidRatio > MAX_INVALID_UTF8_RATIO) {
    return { ok: false, rejection: reject(400, "File is not valid UTF-8 text.") };
  }
  return { ok: true, text };
}

export function checkExpectedShape(text: string): Rejection | null {
  const firstNonBlankLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  if (!looksLikeExpectedFormat(firstNonBlankLine)) {
    return reject(
      400,
      "File does not look like the expected log format (first line should contain a 'datetime=' field).",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ValidatedUpload {
  /** Sanitized, safe-for-display filename (the original client filename — never used for storage paths). */
  filename: string;
  /** Decoded UTF-8 text, for convenience — the route re-parses from the raw buffer for byte-accurate line handling. */
  text: string;
}

export type ValidateUploadResult =
  | { ok: true; result: ValidatedUpload }
  | { ok: false; rejection: Rejection };

/**
 * Runs all four validation checks in the exact locked order (DECISIONS.md
 * §5/§9/§14a), short-circuiting on the first failure. Never touches
 * Storage or the DB — this is pure, synchronous, in-memory validation.
 */
export function validateUpload(originalFilename: string, buffer: Buffer): ValidateUploadResult {
  const extensionRejection = checkExtension(originalFilename);
  if (extensionRejection) return { ok: false, rejection: extensionRejection };

  const sizeRejection = checkFileSize(buffer);
  if (sizeRejection) return { ok: false, rejection: sizeRejection };

  const filenameRejection = checkFilename(originalFilename);
  if (filenameRejection) return { ok: false, rejection: filenameRejection };

  const signatureRejection = checkBinarySignature(buffer);
  if (signatureRejection) return { ok: false, rejection: signatureRejection };

  const nullByteRejection = checkNullBytes(buffer);
  if (nullByteRejection) return { ok: false, rejection: nullByteRejection };

  const decoded = decodeUtf8WithThreshold(buffer);
  if (!decoded.ok || decoded.text === undefined) {
    return { ok: false, rejection: decoded.rejection! };
  }

  const shapeRejection = checkExpectedShape(decoded.text);
  if (shapeRejection) return { ok: false, rejection: shapeRejection };

  return { ok: true, result: { filename: originalFilename, text: decoded.text } };
}

// ---------------------------------------------------------------------------
// Multer wiring — memory storage only, extension + size enforced at the
// multipart-parsing layer itself (stops buffering as early as possible).
// ---------------------------------------------------------------------------

function multerFileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  callback: multer.FileFilterCallback,
): void {
  const rejection = checkExtension(file.originalname);
  if (rejection) {
    callback(new Error(rejection.message));
    return;
  }
  callback(null, true);
}

export const uploadMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: multerFileFilter,
});
