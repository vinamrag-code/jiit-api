/**
 * Smoke test against the **live** portal: calls every read-only endpoint once with a real session and
 * reports which ones actually work.
 *
 * The unit tests all run against a fake `fetch`, and the payloads here were ported by reading jsjiit's
 * minified dist rather than by running it - and this API fails quietly, answering a wrong field name with
 * an empty or "Failure" response rather than an error. So nothing is really known to work until this passes.
 *
 * Usage (from a session captured by the sign-in bookmarklet):
 *
 *   npm run smoke -- --url "http://localhost:5173/#/import-session?token=...&memberid=..."
 *   npm run smoke -- --session session.json      # either a saved session or the raw response fields
 *   npm run smoke -- --url "..." --api-url http://localhost:5173/api/StudentPortalAPI
 *
 * It prints response *shapes* - key names, array lengths - and never values, so the output is safe to paste
 * into an issue. `--verbose` prints values too; don't share that. Tokens are redacted either way.
 *
 * Only read-only endpoints run. `change_password` and `fill_feedback_form` are deliberately excluded: they
 * change your account and submit real feedback.
 */
import fs from "node:fs";
import { WebPortal, WebPortalSession, parseImportParams, DEFAULT_API_URL } from "../src/index.js";
import { createTlsFetch } from "./tlsFetch.mjs";

// ----------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const verbose = !!args.verbose;
const apiUrl = args["api-url"] ?? DEFAULT_API_URL;

function loadSession() {
  if (args.url) return WebPortalSession.fromGoogleResponse(parseImportParams(String(args.url)));
  if (args.session) {
    const raw = JSON.parse(fs.readFileSync(args.session, "utf8"));
    // Accept either a session saved with toJSON(), or the raw sign-in response fields.
    return WebPortalSession.fromJSON(raw) ?? WebPortalSession.fromGoogleResponse(raw);
  }
  if (process.env.JIIT_SESSION) {
    const raw = JSON.parse(process.env.JIIT_SESSION);
    return WebPortalSession.fromJSON(raw) ?? WebPortalSession.fromGoogleResponse(raw);
  }
  console.error(`No session given.

Capture one by running the sign-in bookmarklet on the portal, then pass the redirect URL:

  npm run smoke -- --url "http://localhost:5173/#/import-session?token=...&memberid=..."

or point --session at a JSON file, or set JIIT_SESSION.`);
  process.exit(2);
}

// -------------------------------------------------------------------- output

const SECRET_KEYS = /token|password|authorization|localname/i;

/** Describes a value by its structure - keys and lengths - so output carries no personal data. */
function shape(value, depth = 0) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[] (empty)";
    return `[${value.length}] of ${shape(value[0], depth + 1)}`;
  }
  if (value instanceof Date) return "Date";
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (depth > 1) return `{${keys.length} keys}`;
    return `{ ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""} }`;
  }
  return typeof value;
}

function redact(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => (SECRET_KEYS.test(k) ? "[redacted]" : v)));
}

const results = [];

async function check(name, fn, { tolerate } = {}) {
  const started = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - started;
    results.push({ name, status: "PASS", ms, detail: shape(value) });
    console.log(`  \x1b[32mPASS\x1b[0m ${name.padEnd(42)} ${String(ms).padStart(5)}ms  ${shape(value)}`);
    if (verbose) console.log(`       ${JSON.stringify(redact(value)).slice(0, 2000)}`);
    return value;
  } catch (err) {
    const ms = Date.now() - started;
    const status = tolerate ? "SKIP" : "FAIL";
    const colour = tolerate ? "\x1b[33m" : "\x1b[31m";
    results.push({ name, status, ms, detail: err.message });
    console.log(`  ${colour}${status}\x1b[0m ${name.padEnd(42)} ${String(ms).padStart(5)}ms  ${err.name}: ${err.message.slice(0, 160)}`);
    return null;
  }
}

// ---------------------------------------------------------------------- main

const session = loadSession();
const w = new WebPortal({ apiUrl, fetch: createTlsFetch(), session });

console.log(`\njiit-api smoke test`);
console.log(`  api      ${apiUrl}`);
console.log(`  student  ${session.name ?? "?"} (${session.enrollmentno ?? "?"}), institute ${session.instituteid ?? "?"}`);
console.log(`  token    expires ${session.expiry ? session.expiry.toISOString() : "unknown"}\n`);

if (session.isExpiring(0)) {
  console.log("  \x1b[33mNote\x1b[0m the token is already past its expiry - refresh_session may or may not revive it.\n");
}

console.log("Profile");
await check("get_personal_info", () => w.get_personal_info());
await check("get_student_bank_info", () => w.get_student_bank_info());
// Day scholars have no allocation, so a failure here is not necessarily a bug.
await check("get_hostel_details", () => w.get_hostel_details(), { tolerate: true });

console.log("\nAttendance");
const meta = await check("get_attendance_meta", () => w.get_attendance_meta());
if (meta?.semesters?.length) {
  const attendance = await check("get_attendance", () => w.get_attendance(meta.latest_header(), meta.latest_semester()));
  const row = attendance?.studentattendancelist?.[0];
  if (row) {
    await check("get_subject_daily_attendance", () =>
      w.get_subject_daily_attendance(
        meta.latest_semester(),
        row.subjectid,
        row.subjectcode,
        [row.Lsubjectcomponentid, row.Psubjectcomponentid, row.Tsubjectcomponentid].filter(Boolean),
      ));
  } else {
    console.log("  \x1b[33mSKIP\x1b[0m get_subject_daily_attendance            no attendance rows to derive a subject from");
  }
}

console.log("\nRegistrations");
const semesters = await check("get_registered_semesters", () => w.get_registered_semesters());
if (semesters?.length) {
  await check("get_registered_subjects_and_faculties", () => w.get_registered_subjects_and_faculties(semesters[0]));
  await check("get_subject_choices", () => w.get_subject_choices(semesters[0]));
}

console.log("\nExams");
const examSemesters = await check("get_semesters_for_exam_events", () => w.get_semesters_for_exam_events());
if (examSemesters?.length) {
  const events = await check("get_exam_events", () => w.get_exam_events(examSemesters[0]));
  if (events?.length) await check("get_exam_schedule", () => w.get_exam_schedule(events[0]));
}

console.log("\nMarks and grades");
const markSemesters = await check("get_semesters_for_marks", () => w.get_semesters_for_marks());
if (markSemesters?.length && args.marks) {
  await check("get_marks_pdf", () => w.get_marks_pdf(markSemesters[0]));
} else if (markSemesters?.length) {
  console.log("  \x1b[33mSKIP\x1b[0m get_marks_pdf                             pass --marks to download one");
}
const gradeSemesters = await check("get_semesters_for_grade_card", () => w.get_semesters_for_grade_card());
const complete = gradeSemesters?.find((s) => s.is_grade_card_complete);
if (complete) await check("get_grade_card", () => w.get_grade_card(complete));
await check("get_sgpa_cgpa", () => w.get_sgpa_cgpa());

console.log("\nFees");
await check("get_fee_summary", () => w.get_fee_summary());
// "NO APPROVED REQUEST FOUND" just means nothing is pending, the same kind of business answer
// as the hosteller check above.
await check("get_fines_msc_charges", () => w.get_fines_msc_charges(), { tolerate: true });

// Last, deliberately: this is the only call here that changes server-side state, so if it goes wrong it
// must not be able to invalidate the session for everything above it.
console.log("\nSession");
await check("refresh_session", async () => {
  const ok = await w.refresh_session();
  if (!ok) throw new Error("the portal did not answer Success - the session may be dead");
  return { refreshed: ok };
});

// ------------------------------------------------------------------- summary

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP").length;

console.log(`\n${"-".repeat(72)}`);
console.log(`${passed} passed, ${failed.length} failed, ${skipped} tolerated`);
if (failed.length) {
  console.log(`\nFailed:`);
  for (const r of failed) console.log(`  ${r.name}: ${r.detail}`);
  console.log(`\nA failure here usually means that endpoint's payload is wrong in src/client.js, not that the\nsession is bad - the session is proven by whatever passed above.`);
}
console.log(`\nNot run (they change your account): change_password, fill_feedback_form\n`);

process.exit(failed.length ? 1 : 0);
