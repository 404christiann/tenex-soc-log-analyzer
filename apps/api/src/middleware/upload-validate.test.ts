import { describe, expect, it } from "vitest";
import {
  MAX_FILE_SIZE_BYTES,
  checkBinarySignature,
  checkExpectedShape,
  checkExtension,
  checkFileSize,
  checkFilename,
  checkNullBytes,
  decodeUtf8WithThreshold,
  validateUpload,
} from "./upload-validate";

/**
 * Unit tests for every upload-rejection case (DECISIONS.md §5/§9/§14a). Each
 * test operates on small synthetic buffers/filenames only — no Storage or DB
 * call is reachable from this module at all (it's pure validation logic),
 * which is itself the proof that every rejection happens before anything is
 * persisted: `validate-upload.ts` never imports `db/supabase` or touches any
 * I/O, so a passing test here is structurally guaranteed to run before any
 * Storage/DB call the route makes afterward.
 */

const VALID_LINE = "datetime=2026-01-05T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://example.com/\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=500\tuseragent=Mozilla/5.0\treqmethod=GET";

function validBuffer(): Buffer {
  return Buffer.from(`${VALID_LINE}\n`, "utf-8");
}

describe("checkExtension", () => {
  it("accepts .log (any case)", () => {
    expect(checkExtension("access.log")).toBeNull();
    expect(checkExtension("ACCESS.LOG")).toBeNull();
  });

  it("accepts .txt", () => {
    expect(checkExtension("notes.txt")).toBeNull();
  });

  it("rejects any other extension with a 400", () => {
    const rejection = checkExtension("malware.exe");
    expect(rejection).not.toBeNull();
    expect(rejection?.status).toBe(400);
  });

  it("rejects a file with no extension", () => {
    const rejection = checkExtension("noextension");
    expect(rejection?.status).toBe(400);
  });
});

describe("checkFileSize", () => {
  it("accepts a buffer at or under the 10MB cap", () => {
    expect(checkFileSize(Buffer.alloc(MAX_FILE_SIZE_BYTES))).toBeNull();
  });

  it("rejects an oversized buffer with a 413", () => {
    const rejection = checkFileSize(Buffer.alloc(MAX_FILE_SIZE_BYTES + 1));
    expect(rejection).not.toBeNull();
    expect(rejection?.status).toBe(413);
  });
});

describe("checkFilename", () => {
  it("accepts a normal filename", () => {
    expect(checkFilename("normal-traffic.log")).toBeNull();
  });

  it("rejects an empty filename", () => {
    expect(checkFilename("")?.status).toBe(400);
  });

  it("rejects path traversal via ../", () => {
    expect(checkFilename("../../etc/passwd.log")?.status).toBe(400);
  });

  it("rejects an embedded path separator", () => {
    expect(checkFilename("some/dir/file.log")?.status).toBe(400);
    expect(checkFilename("some\\dir\\file.log")?.status).toBe(400);
  });

  it("rejects control characters (e.g. an embedded null byte in the name)", () => {
    expect(checkFilename("evil\x00.log")?.status).toBe(400);
  });
});

describe("checkBinarySignature", () => {
  it("allows plain text content", () => {
    expect(checkBinarySignature(validBuffer())).toBeNull();
  });

  it.each([
    ["PDF", Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])],
    ["ZIP/docx/xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])],
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
    ["ELF", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])],
  ])("rejects a %s magic-byte signature with a 400", (_name, sigBuffer) => {
    const rejection = checkBinarySignature(sigBuffer);
    expect(rejection).not.toBeNull();
    expect(rejection?.status).toBe(400);
  });
});

describe("checkNullBytes", () => {
  it("allows content with no null bytes", () => {
    expect(checkNullBytes(validBuffer())).toBeNull();
  });

  it("rejects content containing a null byte with a 400", () => {
    const buf = Buffer.concat([Buffer.from("datetime=2026\0garbage"), Buffer.from("\n")]);
    const rejection = checkNullBytes(buf);
    expect(rejection).not.toBeNull();
    expect(rejection?.status).toBe(400);
  });
});

describe("decodeUtf8WithThreshold", () => {
  it("decodes valid UTF-8", () => {
    const result = decodeUtf8WithThreshold(validBuffer());
    expect(result.ok).toBe(true);
    expect(result.text).toContain("datetime=");
  });

  it("rejects a short buffer that's mostly invalid UTF-8 (e.g. a raw binary blob) with a 400", () => {
    // 0xFF 0xFE is not a valid UTF-8 continuation sequence; 2 of 4 bytes
    // invalid is far past the 2% threshold (DECISIONS.md §14b).
    const buf = Buffer.from([0xff, 0xfe, 0x41, 0x42]);
    const result = decodeUtf8WithThreshold(buf);
    expect(result.ok).toBe(false);
    expect(result.rejection?.status).toBe(400);
  });

  it("DECISIONS.md §14b: accepts mostly-valid text with only a couple of corrupted bytes (well under 2%)", () => {
    // ~50 valid lines (≈2500+ bytes) with 2 invalid bytes spliced into one
    // line — mirrors examples/malformed-edge-cases.log's construction.
    const lines = Array.from({ length: 50 }, () => VALID_LINE);
    const text = lines.join("\n");
    const validPart = Buffer.from(text, "utf-8");
    const corrupted = Buffer.concat([
      validPart,
      Buffer.from([0xff, 0xfe]), // 2 invalid bytes among thousands of valid ones
      Buffer.from("\n", "utf-8"),
    ]);
    const result = decodeUtf8WithThreshold(corrupted);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("datetime=");
  });

  it("DECISIONS.md §14b: rejects a buffer that's mostly invalid bytes (simulated binary content), even though a small prefix is valid text", () => {
    const mostlyBinary = Buffer.concat([
      Buffer.from("datetime=2026\n", "utf-8"),
      Buffer.from(Array.from({ length: 500 }, () => 0xff)),
    ]);
    const result = decodeUtf8WithThreshold(mostlyBinary);
    expect(result.ok).toBe(false);
    expect(result.rejection?.status).toBe(400);
  });
});

describe("checkExpectedShape", () => {
  it("accepts text whose first non-blank line contains datetime=", () => {
    expect(checkExpectedShape(`\n\n${VALID_LINE}\n`)).toBeNull();
  });

  it("rejects text that doesn't look like the expected log format", () => {
    const rejection = checkExpectedShape("just,some,csv,data\nrow2,val2\n");
    expect(rejection).not.toBeNull();
    expect(rejection?.status).toBe(400);
  });

  it("rejects an empty file", () => {
    expect(checkExpectedShape("")?.status).toBe(400);
  });
});

describe("validateUpload — full orchestration, locked order", () => {
  it("accepts a valid .log file with expected content", () => {
    const result = validateUpload("quick-demo.log", validBuffer());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.filename).toBe("quick-demo.log");
      expect(result.result.text).toContain("datetime=");
    }
  });

  it("rejects wrong extension before inspecting content", () => {
    // Buffer content is otherwise perfectly valid — only the extension is wrong.
    const result = validateUpload("quick-demo.pdf", validBuffer());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.status).toBe(400);
  });

  it("rejects an oversized file", () => {
    const oversized = Buffer.concat([validBuffer(), Buffer.alloc(MAX_FILE_SIZE_BYTES)]);
    const result = validateUpload("big.log", oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.status).toBe(413);
  });

  it("rejects path-traversal filenames even with valid content", () => {
    const result = validateUpload("../escape.log", validBuffer());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.status).toBe(400);
  });

  it("rejects a binary file disguised with a .log extension", () => {
    const disguisedPdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const result = validateUpload("innocent.log", disguisedPdf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.status).toBe(400);
  });

  it("rejects a file with null bytes despite the right extension", () => {
    const buf = Buffer.concat([Buffer.from("datetime=2026\0"), Buffer.from("\n")]);
    const result = validateUpload("weird.log", buf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.status).toBe(400);
  });

  it("rejects invalid UTF-8 despite the right extension", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x41, 0x42]);
    const result = validateUpload("weird.log", buf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.status).toBe(400);
  });

  it("rejects content that doesn't match the expected header shape", () => {
    const buf = Buffer.from("this,is,not,the,right,format\n");
    const result = validateUpload("mystery.log", buf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.status).toBe(400);
  });
});
