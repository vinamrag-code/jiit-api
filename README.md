# jiit-api

A JavaScript client for JIIT's student web portal (the "CampusLynx" `StudentPortalAPI` backend) — attendance,
grades, exam schedules, marks, registrations, fees and hostel details — including the **Google sign-in
handoff** the portal switched students to in September 2026.

Extracted from [jportal](../jportal) so the data layer stops being scattered across an app. Runs in browsers,
in Capacitor/WebView apps, and in Node 18+.

## Install

```sh
npm install jiit-api        # once published
# or, for now, from the repo:
npm install github:<you>/jiit-api
```

## Quick start

```js
import { WebPortal, WebPortalSession, parseImportParams } from "jiit-api";

const w = new WebPortal({ apiUrl: "/api/StudentPortalAPI" }); // see "Reaching the API" below

// after the sign-in handoff redirects to your app:
w.importGoogleSession(parseImportParams(window.location.search));

const meta = await w.get_attendance_meta();
const attendance = await w.get_attendance(meta.latest_header(), meta.latest_semester());

// persist and resume, so the student isn't sent back through Google every launch:
localStorage.setItem("jiit-session", JSON.stringify(w.session));
const resumed = new WebPortal({
  session: WebPortalSession.fromJSON(JSON.parse(localStorage.getItem("jiit-session"))),
});
```

## Signing in

Students can no longer sign in with a password. A "Sign in with Google" button in **your** app cannot work
either: the portal's OAuth client authorizes only `webportal.jiit.ac.in`'s own origin, so Google answers
`origin_mismatch` anywhere else — in a browser, in a WebView, and from a native app (Android's Credential
Manager enforces the same rule from the other side, needing your app registered under *JIIT's* Cloud project;
confirmed dead on a real device). Google also blocks its sign-in flow inside embedded WebViews outright.

So the student signs in **on the portal's own page**, and a bookmarklet — running as that page's own script,
so nothing is cross-origin — captures the session and redirects it to your app:

```js
import { buildBookmarklet, bookmarkletScript, PORTAL_LOGIN_URL } from "jiit-api/bookmarklet";

buildBookmarklet(window.location.origin);  // a javascript: URI for a bookmark
bookmarkletScript(window.location.origin); // the same script, to paste into devtools
```

1. The student installs the bookmarklet (or copies the script).
2. Opens `PORTAL_LOGIN_URL`.
3. Runs the bookmarklet **first** — it confirms with a "Ready" alert.
4. Clicks "Sign in with Google" as normal, and lands back on your app at
   `<your origin>/#/import-session?token=…`, which you hand to `importGoogleSession`.

Offer the devtools form as a fallback: Firefox, and any page with a strict `script-src` CSP, refuse to run
bookmarklets.

Once signed in, `refresh_session()` extends the session server-side with no Google round trip — authenticated
calls do it automatically when the token is within a minute of expiring.

## Reaching the API

The portal sends **no CORS headers**, so browser code must point `apiUrl` at a proxy. Two things that proxy
must do, both verified against the live server (18 Sep 2026) and both easy to lose hours to:

- **Rewrite `Origin` (and `Referer`) to `https://webportal.jiit.ac.in:6011`.** Any foreign origin is answered
  `403 Invalid CORS request` — as a plain-text body, so it surfaces as a JSON parse error rather than
  anything mentioning CORS. Measured: `Origin: http://localhost:5173` → 403, the portal's own origin → 200.
  The browser sets `Origin` itself and it cannot be overridden from `fetch`, so only a proxy can fix it.
- **Cap TLS at 1.2.** The server aborts the handshake on most connections offering TLS 1.3, which is Node's
  default — `socket hang up` / `Client network socket disconnected before secure TLS connection was
  established`, surfacing as empty-bodied 500s. Measured: 0/3 succeeded on Node defaults, 3/3 capped. curl
  and browsers land on 1.2 anyway, which is why curl never reproduces it.

A Vite dev proxy doing both:

```js
// vite.config.js
import https from "https";
const PORTAL = "https://webportal.jiit.ac.in:6011";
const agent = new https.Agent({ maxVersion: "TLSv1.2", keepAlive: true });

server: {
  proxy: {
    "/api/StudentPortalAPI": {
      target: PORTAL, changeOrigin: true, secure: false, agent,
      rewrite: (p) => p.replace(/^\/api/, ""),
      configure: (proxy) => proxy.on("proxyReq", (req) => {
        req.setHeader("origin", PORTAL);
        req.setHeader("referer", PORTAL + "/studentportal/");
      }),
    },
  },
}
```

**Native apps need no proxy** — pass the portal's own URL (`DEFAULT_API_URL`) and a `fetch` that isn't subject
to CORS, such as one backed by Capacitor's `CapacitorHttp`.

## API

`new WebPortal({ apiUrl, fetch, session })`

| | |
|---|---|
| **Sign-in** | `student_login(username, password)` (non-student member types only), `importGoogleSession(response)`, `refresh_session()` |
| **Student** | `get_personal_info()`, `get_student_bank_info()`, `change_password(old, new)`, `get_hostel_details()` |
| **Attendance** | `get_attendance_meta()`, `get_attendance(header, semester)`, `get_subject_daily_attendance(semester, subjectid, subjectcode, componentids)` |
| **Registrations** | `get_registered_semesters()`, `get_registered_subjects_and_faculties(semester)`, `get_subject_choices(semester)` |
| **Exams** | `get_semesters_for_exam_events()`, `get_exam_events(semester)`, `get_exam_schedule(examEvent)` |
| **Marks** | `get_semesters_for_marks()`, `get_marks_pdf(semester)` → `Blob`, `download_marks(semester)` (browser) |
| **Grades** | `get_semesters_for_grade_card()`, `get_grade_card(semester)`, `get_sgpa_cgpa()` |
| **Fees** | `get_fee_summary()`, `get_fines_msc_charges()` |
| **Feedback** | `fill_feedback_form(rating)` |

Errors: `APIError`, `LoginError`, `AccountAPIError`, `SessionError`, `SessionExpired`, `NotLoggedIn`.
A 401 really does arrive as `SessionExpired`, so callers can tell an expired session from a failed request.

## Credits

Built on the reverse engineering in [**jsjiit**](https://github.com/codeblech/jsjiit) and
[pyjiit](https://github.com/codeblech/pyjiit) by Yash Malik — the endpoint map, the payload encryption and the
`LocalName` header scheme are theirs. This is a from-scratch rewrite rather than a fork: same method names and
return shapes, plus Google sign-in, serializable sessions, no DOM dependency, and a 401 that survives as
`SessionExpired`.

Not affiliated with or endorsed by JIIT.
