import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TICKET-301 acceptance criterion: "No capture or charge call exists
 * anywhere in this package." This walks every source `.ts` file under
 * `packages/payments` (excluding `tests/` and build output) and asserts none
 * of them contain a capture/charge-shaped call — a call expression, method
 * call, or function/const declaration whose name matches
 * /capture|charge/i followed by `(`.
 *
 * Deliberately scoped to call-and-declaration SHAPES (`capture(`,
 * `.charge(`, `function captureX(`, `const chargeX = (`) rather than the
 * bare words "capture"/"charge", so this test does not trip over doc
 * comments that mention the words while explaining why no such call exists
 * (e.g. this very file's own module comment, or razorpay-client.ts's).
 */

const packageRoot = path.join(__dirname, "..");

const SOURCE_DIRS = ["src", "index.ts"];
const FORBIDDEN_CALL_PATTERN = new RegExp(
  [
    // capture(...), .capture(...), captureOrder(...), function captureOrder(...
    String.raw`\b\w*(?:capture|charge)\w*\s*\(`,
    // const/let/var chargePayment = ...
    String.raw`\b(?:const|let|var)\s+\w*(?:capture|charge)\w*\s*=`,
  ].join("|"),
  "i",
);

function collectTsFiles(entryPath: string): string[] {
  const stats = statSync(entryPath);
  if (stats.isFile()) {
    return entryPath.endsWith(".ts") ? [entryPath] : [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(entryPath)) {
    files.push(...collectTsFiles(path.join(entryPath, entry)));
  }
  return files;
}

const filesToCheck = SOURCE_DIRS.flatMap((relative) =>
  collectTsFiles(path.join(packageRoot, relative)),
);

describe("no capture or charge call exists anywhere in packages/payments", () => {
  it("finds at least one source file to check (sanity check on the test itself)", () => {
    expect(filesToCheck.length).toBeGreaterThan(0);
  });

  it.each(filesToCheck.map((file) => [path.relative(packageRoot, file), file] as const))(
    "%s contains no capture/charge call",
    (_label, file) => {
      const contents = readFileSync(file, "utf8");
      const withoutComments = stripComments(contents);
      const hits = withoutComments.match(FORBIDDEN_CALL_PATTERN);

      expect(hits, `Forbidden capture/charge call shape found in ${file}: ${hits?.[0]}`).toBeNull();
    },
  );
});

/** Strips /* *\/ block comments and // line comments so doc prose mentioning
 * "capture"/"charge" (explaining why no such call exists) cannot itself trip
 * the pattern above — only real code shapes count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
