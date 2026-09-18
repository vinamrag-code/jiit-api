/**
 * The portal API client. Every method mirrors jsjiit's, name for name and return shape for return shape,
 * so an app already written against jsjiit only has to change where it imports `WebPortal` from.
 *
 * Differences from jsjiit, all deliberate:
 * - **Sessions are separate and serializable.** `session` is a `WebPortalSession` you can `toJSON()` and
 *   restore later; the Google sign-in flow (`fromGoogleResponse`) produces the same object the password
 *   flow does.
 * - **`SessionExpired` survives.** jsjiit throws it on a 401 inside a `try` whose own `catch` immediately
 *   re-wraps it as a plain `APIError`, so callers can never actually distinguish an expired session.
 * - **The token refreshes itself.** Any authenticated call whose token is within a minute of its `exp`
 *   claim calls `/token/refreshTokenRequest` first, which extends it server-side with no Google round trip.
 * - **No DOM.** `get_marks_pdf` returns a `Blob`; `download_marks` (the browser-only convenience that
 *   clicks an `<a>`) is layered on top of it.
 *
 * ## Reaching the API from a browser
 * The portal sends no CORS headers, so browser code must point `apiUrl` at a proxy rather than at the
 * portal. Two things that proxy must do, both verified against the live server (18 Sep 2026):
 * - **Rewrite `Origin` (and `Referer`) to the portal's own origin.** Any foreign origin is answered with
 *   `403 Invalid CORS request` - as a plain-text body, so it surfaces as a JSON parse error.
 * - **Cap TLS at 1.2.** The server aborts the handshake on most connections offering TLS 1.3, which is
 *   Node's default; measured 0/3 succeeding on defaults vs 3/3 capped.
 * Native apps (Capacitor's `CapacitorHttp`, or anything not in a browser) need no proxy - pass the portal's
 * own URL and a `fetch` that isn't subject to CORS.
 */
import { APIError, LoginError, AccountAPIError, SessionExpired, NotLoggedIn } from "./errors.js";
import { generateLocalName, serializePayload } from "./crypto.js";
import { WebPortalSession } from "./session.js";
import { AttendanceMeta, ExamEvent, Registrations, Semester } from "./models.js";

export const DEFAULT_API_URL = "https://webportal.jiit.ac.in:6011/StudentPortalAPI";

/** The captcha the portal's own login form ships hard-coded - it is not actually checked. */
export const DEFAULT_CAPTCHA = { captcha: "phw5n", hidden: "gmBctEffdSg=" };

export class WebPortal {
  /**
   * @param {object} [options]
   * @param {string} [options.apiUrl] Base URL - the portal's own, or a proxy in front of it (see above).
   * @param {Function} [options.fetch] `fetch` implementation, for non-browser hosts.
   * @param {WebPortalSession} [options.session] Restore a previously persisted session.
   */
  constructor({ apiUrl = DEFAULT_API_URL, fetch: fetchImpl, session = null } = {}) {
    this.apiUrl = apiUrl;
    this.session = session;
    this._fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!this._fetch) throw new Error("No fetch available - pass one as options.fetch.");
  }

  get isLoggedIn() {
    return !!this.session?.token;
  }

  _requireSession() {
    if (!this.isLoggedIn) throw new NotLoggedIn();
    return this.session;
  }

  /**
   * One API call. `json` is sent as a JSON body, `body` as-is (that's how the encrypted payloads go out),
   * and `authenticated` attaches the bearer token, refreshing it first if it is about to expire.
   */
  async __hit(method, path, { json, body, authenticated = false, exception = APIError, headers = {} } = {}) {
    let authHeaders;
    if (authenticated) {
      const session = this._requireSession();
      if (session.isExpiring()) await this.refresh_session();
      authHeaders = await session.get_headers();
    } else {
      authHeaders = { LocalName: await generateLocalName() };
    }

    let res;
    try {
      res = await this._fetch(this.apiUrl + path, {
        method,
        headers: { "Content-Type": "application/json", ...headers, ...authHeaders },
        body: json !== undefined ? JSON.stringify(json) : body,
      });
    } catch (err) {
      // A CORS rejection reaches JS as an opaque TypeError with no status - worth naming, since pointing
      // `apiUrl` at a proxy is the fix and the raw message never says so.
      if (err instanceof TypeError) {
        throw new exception(`Could not reach the portal at ${this.apiUrl} (${err.message}). From a browser this is usually CORS - point apiUrl at a proxy.`);
      }
      throw new exception(err.message || "Unknown network error");
    }

    if (res.status === 401) throw new SessionExpired("The portal rejected the session token (401).");
    if (res.status === 513) throw new exception("JIIT Web Portal server is temporarily unavailable (HTTP 513). Please try again later.");

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new exception(`${res.status} ${res.statusText}: the portal answered with something that isn't JSON: ${text.slice(0, 200)}`);
    }
    if (data.status && data.status.responseStatus !== "Success") {
      throw new exception(`status:\n${JSON.stringify(data.status, null, 2)}`);
    }
    return data;
  }

  // ---------------------------------------------------------------- sign-in

  /**
   * Username/password login. Students can no longer use this - the portal moved them to Google sign-in in
   * Sep 2026 (see `bookmarklet.js`) - but other member types still can.
   */
  async student_login(username, password, captcha = DEFAULT_CAPTCHA) {
    const pretoken = await this.__hit("POST", "/token/pretoken-check", {
      body: await serializePayload({ username, usertype: "S", captcha }),
      exception: LoginError,
    });

    const payload = { ...pretoken.response, Modulename: "STUDENTMODULE", passwordotpvalue: password };
    delete payload.rejectedData;

    const login = await this.__hit("POST", "/token/generatewebtoken", {
      body: await serializePayload(payload),
      exception: LoginError,
    });

    this.session = WebPortalSession.fromLoginResponse(login.response);
    return this.session;
  }

  /**
   * Adopts a session captured from the portal's Google sign-in response (see `bookmarklet.js`).
   * `response` is the response object, or the redirect's params run through `parseImportParams`.
   */
  importGoogleSession(response) {
    this.session = WebPortalSession.fromGoogleResponse(response);
    return this.session;
  }

  /**
   * Extends the current session server-side - no Google credential needed, which is what keeps a signed-in
   * student from being sent back through sign-in on every launch. The portal's own frontend does the same
   * on a 401. A "Success" answer means the *existing* bearer token keeps working; no new token is issued,
   * so there is nothing to store beyond the refreshed `tokenDate`.
   */
  async refresh_session() {
    const session = this._requireSession();
    try {
      const res = await this._fetch(this.apiUrl + "/token/refreshTokenRequest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
          LocalName: await generateLocalName(),
        },
        body: JSON.stringify({ username: session.username, tokendate: session.tokenDate }),
      });
      const data = await res.json().catch(() => null);
      if (data?.response?.msg !== "Success") return false;
      session.tokenDate = new Date().toISOString();
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ student

  async get_personal_info() {
    const s = this._requireSession();
    // `clinetid` is the portal's own typo, not ours - it rejects the corrected spelling.
    const json = { clinetid: "SOAU", instituteid: s.instituteid };
    return (await this.__hit("POST", "/studentpersinfo/getstudent-personalinformation", { json, authenticated: true })).response;
  }

  async get_student_bank_info() {
    const s = this._requireSession();
    const json = { instituteid: s.instituteid, studentid: s.memberid };
    return (await this.__hit("POST", "/studentbankdetails/getstudentbankinfo", { json, authenticated: true })).response;
  }

  async change_password(oldPassword, newPassword) {
    const s = this._requireSession();
    const json = { membertype: s.membertype, oldpassword: oldPassword, newpassword: newPassword, confirmpassword: newPassword };
    return (await this.__hit("POST", "/clxuser/changepassword", { json, authenticated: true, exception: AccountAPIError })).response;
  }

  // --------------------------------------------------------------- attendance

  async get_attendance_meta() {
    const s = this._requireSession();
    const json = { clientid: s.clientid, instituteid: s.instituteid, membertype: s.membertype };
    const res = await this.__hit("POST", "/StudentClassAttendance/getstudentInforegistrationforattendence", { json, authenticated: true });
    return new AttendanceMeta(res.response);
  }

  async get_attendance(header, semester) {
    const s = this._requireSession();
    const body = await serializePayload({
      clientid: s.clientid,
      instituteid: s.instituteid,
      registrationcode: semester.registration_code,
      registrationid: semester.registration_id,
      stynumber: header.stynumber,
    });
    return (await this.__hit("POST", "/StudentClassAttendance/getstudentattendancedetail", { json: body, authenticated: true })).response;
  }

  async get_subject_daily_attendance(semester, subjectid, subjectcode, componentids) {
    const s = this._requireSession();
    const body = await serializePayload({
      cmpidkey: componentids.map((id) => ({ subjectcomponentid: id })),
      clientid: s.clientid,
      instituteid: s.instituteid,
      registrationcode: semester.registration_code,
      registrationid: semester.registration_id,
      subjectcode,
      subjectid,
    });
    return (await this.__hit("POST", "/StudentClassAttendance/getstudentsubjectpersentage", { json: body, authenticated: true })).response;
  }

  // ------------------------------------------------------------- registrations

  async get_registered_semesters() {
    const s = this._requireSession();
    const body = await serializePayload({ instituteid: s.instituteid, studentid: s.memberid });
    const res = await this.__hit("POST", "/reqsubfaculty/getregistrationList", { json: body, authenticated: true });
    return res.response.registrations.map((r) => Semester.from_json(r));
  }

  async get_registered_subjects_and_faculties(semester) {
    const s = this._requireSession();
    const body = await serializePayload({ instituteid: s.instituteid, studentid: s.memberid, registrationid: semester.registration_id });
    const res = await this.__hit("POST", "/reqsubfaculty/getfaculties", { json: body, authenticated: true });
    return new Registrations(res.response);
  }

  async get_subject_choices(semester) {
    const s = this._requireSession();
    const body = await serializePayload({ instituteid: s.instituteid, clientid: s.clientid, registrationid: semester.registration_id });
    return (await this.__hit("POST", "/studentchoiceprint/getsubjectpreference", { json: body, authenticated: true })).response;
  }

  // -------------------------------------------------------------------- exams

  async get_semesters_for_exam_events() {
    const s = this._requireSession();
    const body = await serializePayload({ clientid: s.clientid, instituteid: s.instituteid, memberid: s.memberid });
    const res = await this.__hit("POST", "/studentcommonsontroller/getsemestercode-withstudentexamevents", { json: body, authenticated: true });
    return res.response.semesterCodeinfo.semestercode.map((sem) => Semester.from_json(sem));
  }

  async get_exam_events(semester) {
    const s = this._requireSession();
    // `registationid` is the portal's spelling on this endpoint. It is not a typo on our side.
    const body = await serializePayload({ instituteid: s.instituteid, registationid: semester.registration_id });
    const res = await this.__hit("POST", "/studentcommonsontroller/getstudentexamevents", { json: body, authenticated: true });
    return res.response.eventcode.examevent.map(ExamEvent.from_json);
  }

  async get_exam_schedule(examEvent) {
    const s = this._requireSession();
    const body = await serializePayload({
      instituteid: s.instituteid,
      registrationid: examEvent.registration_id,
      exameventid: examEvent.exam_event_id,
    });
    return (await this.__hit("POST", "/studentsttattview/getstudent-examschedule", { json: body, authenticated: true })).response;
  }

  // -------------------------------------------------------------------- marks

  async get_semesters_for_marks() {
    const s = this._requireSession();
    const body = await serializePayload({ instituteid: s.instituteid, studentid: s.memberid });
    const res = await this.__hit("POST", "/studentcommonsontroller/getsemestercode-exammarks", { json: body, authenticated: true });
    return res.response.semestercode.map((sem) => Semester.from_json(sem));
  }

  /** The marks sheet as a `Blob`. The only endpoint that is a GET, and the only one returning a PDF. */
  async get_marks_pdf(semester) {
    const s = this._requireSession();
    const path = `/studentsexamview/printstudent-exammarks/${s.instituteid}/${semester.registration_id}/${semester.registration_code}`;
    const res = await this._fetch(this.apiUrl + path, { method: "GET", headers: await s.get_headers() });
    if (!res.ok) throw new APIError(`Couldn't download the marks sheet (${res.status} ${res.statusText}).`);
    return res.blob();
  }

  /** Browser convenience: fetch the marks sheet and save it. Needs a DOM. */
  async download_marks(semester) {
    const blob = await this.get_marks_pdf(semester);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `marks_${semester.registration_code}.pdf`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();
  }

  // --------------------------------------------------------------- grade card

  /**
   * Two sources, merged: `studentgradecard` lists semesters with a real, published grade card, while
   * `studentchoiceprint` lists every semester the student registered for. The app wants both (so a current
   * semester still shows up), tagged with which one it came from - an official entry wins on conflict.
   */
  async get_semesters_for_grade_card() {
    const s = this._requireSession();
    const [official, choice] = await Promise.all([
      this.__hit("POST", "/studentgradecard/getregistrationList", {
        json: await serializePayload({ instituteid: s.instituteid }),
        authenticated: true,
      }),
      this.__hit("POST", "/studentchoiceprint/getsemestercodelist", {
        json: await serializePayload({ instituteid: s.instituteid, clientid: s.clientid }),
        authenticated: true,
      }),
    ]);

    const complete = (official?.response?.registrations || []).map((r) =>
      Semester.from_json(r, { is_grade_card_complete: true, grade_card_source: "official" }),
    );
    const registered = (choice?.response?.registrations || choice?.response?.semesterlist || choice?.response?.semestercode || []).map((r) =>
      Semester.from_json(r, { is_grade_card_complete: false, grade_card_source: "choice" }),
    );

    const merged = new Map();
    for (const sem of registered) merged.set(sem.registration_id, sem);
    for (const sem of complete) merged.set(sem.registration_id, sem);
    return Array.from(merged.values());
  }

  async __get_grade_card_student_info() {
    const s = this._requireSession();
    const body = await serializePayload({ instituteid: s.instituteid });
    return (await this.__hit("POST", "/studentgradecard/getstudentinfo", { json: body, authenticated: true })).response;
  }

  async __get_program_id() {
    return (await this.__get_grade_card_student_info())?.programid ?? null;
  }

  async get_grade_card(semester) {
    const s = this._requireSession();
    const info = await this.__get_grade_card_student_info();
    const body = await serializePayload({
      branchid: info?.branchid,
      instituteid: s.instituteid,
      programid: info?.programid,
      registrationid: semester.registration_id,
    });
    return (await this.__hit("POST", "/studentgradecard/showstudentgradecard", { json: body, authenticated: true })).response;
  }

  async __get_semester_number() {
    const s = this._requireSession();
    const body = await serializePayload({
      instituteid: s.instituteid,
      studentid: s.memberid,
      name: s.name,
      enrollmentno: s.enrollmentno,
    });
    const res = await this.__hit("POST", "/studentsgpacgpa/checkIfstudentmasterexist", { json: body, authenticated: true });
    return res.response.studentlov.currentsemester;
  }

  async get_sgpa_cgpa() {
    const s = this._requireSession();
    const body = await serializePayload({
      instituteid: s.instituteid,
      studentid: s.memberid,
      stynumber: await this.__get_semester_number(),
    });
    return (await this.__hit("POST", "/studentsgpacgpa/getallsemesterdata", { json: body, authenticated: true })).response;
  }

  // ---------------------------------------------------------------- fees etc.

  async get_fines_msc_charges() {
    const s = this._requireSession();
    const body = await serializePayload({ instituteid: s.instituteid, studentid: s.memberid });
    return (await this.__hit("POST", "/collectionpendingpayments/getpendingpaymentsdata", { json: body, authenticated: true })).response;
  }

  async get_fee_summary() {
    const s = this._requireSession();
    return (await this.__hit("POST", "/studentfeeledger/loadfeesummary", { json: { instituteid: s.instituteid }, authenticated: true })).response;
  }

  async get_hostel_details() {
    const s = this._requireSession();
    const json = { clientid: s.clientid, instituteid: s.instituteid, studentid: s.memberid };
    const res = await this.__hit("POST", "/myhostelallocationdetail/gethostelallocationdetail", { json, authenticated: true });
    if (!res?.response) throw new APIError("Hostel details not found");
    return res.response;
  }

  // ------------------------------------------------------------------ feedback

  /**
   * Fills every question of the latest feedback event with the same `rating`. Returns how many
   * faculty/subject forms were submitted and which ones could not be loaded.
   *
   * (jsjiit's version of this throws a `ReferenceError` partway through - it reads an undeclared
   * `questions_api_resp` instead of the result it just fetched - so it has never actually worked.)
   */
  async fill_feedback_form(rating) {
    const s = this._requireSession();
    const events = (await this.__hit("POST", "/feedbackformcontroller/getFeedbackEvent", {
      json: { instituteid: s.instituteid },
      authenticated: true,
    })).response.eventList;
    const event = events[events.length - 1];

    const gridBody = await serializePayload({ instituteid: s.instituteid, studentid: s.memberid, eventid: event.eventid });
    const grid = (await this.__hit("POST", "/feedbackformcontroller/getGriddataForFeedback", { json: gridBody, authenticated: true })).response.gridData;

    const forms = grid.map((row) => ({
      instituteid: s.instituteid,
      eventid: event.eventid,
      eventdescription: event.eventdescription,
      facultyid: row.employeeid,
      facultyname: row.employeename,
      registrationid: row.registrationid,
      studentid: row.studentid,
      subjectcode: row.subjectcode,
      subjectcomponentcode: row.subjectcomponentcode,
      subjectcomponentid: row.subjectcomponentid,
      subjectdescription: row.subjectdescription,
      subjectid: row.subjectid,
    }));

    let submitted = 0;
    const skipped = [];
    for (const form of forms) {
      let questions;
      try {
        const res = await this.__hit("POST", "/feedbackformcontroller/getIemQuestion", { json: form, authenticated: true });
        questions = res?.response?.questionList;
      } catch (err) {
        skipped.push({ form, reason: err.message });
        continue;
      }
      if (!questions) {
        skipped.push({ form, reason: "no question list in the response" });
        continue;
      }

      const payload = await serializePayload({
        instituteid: form.instituteid,
        studentid: s.memberid,
        eventid: form.eventid,
        subjectid: form.subjectid,
        facultyid: form.facultyid,
        registrationid: form.registrationid,
        questionid: questions.map((q) => ({ ...q, rating })),
        facultycomments: null,
        coursecomments: null,
      });
      await this.__hit("POST", "/feedbackformcontroller/savedatalist", { json: payload, authenticated: true });
      submitted++;
    }
    return { submitted, skipped };
  }
}
