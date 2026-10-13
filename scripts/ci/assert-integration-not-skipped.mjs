// Fails the run if the real-MinIO integration suite did not actually execute.
//
// `tests/integration/product-images-minio.integration.test.ts` SKIPS (rather than
// fails) when S3_* is unset or MinIO is unreachable, so a broken CI wiring would
// look green while silently testing nothing. Reads Vitest's JSON report.
//
// Usage: node scripts/ci/assert-integration-not-skipped.mjs <vitest-json-report>
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const minio = report.testResults.filter((file) => file.name.includes("product-images-minio"));
if (minio.length === 0) {
  console.error("[ci] the MinIO integration file is missing from the report");
  process.exit(1);
}
const tests = minio.flatMap((file) => file.assertionResults);
const passed = tests.filter((t) => t.status === "passed").length;
const notRun = tests.filter((t) => t.status !== "passed").length;
if (passed === 0 || notRun > 0) {
  console.error(`[ci] MinIO integration suite did not fully run: ${passed} passed, ${notRun} skipped/failed`);
  process.exit(1);
}
console.log(`[ci] MinIO integration suite ran for real: ${passed} tests passed, 0 skipped`);
