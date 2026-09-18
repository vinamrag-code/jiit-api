/**
 * jiit-api - a client for JIIT's student web portal (the "CampusLynx" StudentPortalAPI backend).
 *
 * Extracted from the jportal app, and a from-scratch successor to `jsjiit` (MIT-era reverse engineering by
 * codeblech, whose endpoint map and crypto scheme this is built on): same method names and return shapes,
 * plus the Google sign-in flow the portal switched students to in Sep 2026, serializable sessions, and no
 * dependence on a DOM.
 *
 * ```js
 * import { WebPortal, WebPortalSession, buildBookmarklet, parseImportParams } from "jiit-api";
 *
 * const w = new WebPortal({ apiUrl: "/api/StudentPortalAPI" }); // a proxy - see client.js on CORS
 * w.importGoogleSession(parseImportParams(window.location.search));
 * const meta = await w.get_attendance_meta();
 * localStorage.setItem("session", JSON.stringify(w.session));   // resume later:
 * // new WebPortal({ session: WebPortalSession.fromJSON(JSON.parse(...)) })
 * ```
 */
export { WebPortal, DEFAULT_API_URL, DEFAULT_CAPTCHA } from "./client.js";
export { WebPortalSession } from "./session.js";
export { buildBookmarklet, bookmarkletScript, parseImportParams, PORTAL_ORIGIN, PORTAL_LOGIN_URL } from "./bookmarklet.js";
export { generateLocalName, serializePayload, generateDateSeq } from "./crypto.js";
export { AttendanceMeta, AttendanceHeader, Semester, ExamEvent, RegisteredSubject, Registrations } from "./models.js";
export { APIError, LoginError, AccountAPIError, SessionError, SessionExpired, NotLoggedIn } from "./errors.js";
