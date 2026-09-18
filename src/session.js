/**
 * The authenticated session: the bearer token plus the handful of ids every endpoint's payload repeats
 * (`instituteid`, `memberid`, `clientid`, ...).
 *
 * Two things can produce one, and they are deliberately the same shape afterward:
 * - `fromLoginResponse` - the old username/password flow (`WebPortal#student_login`), still how non-student
 *   member types sign in.
 * - `fromGoogleResponse` - the Google sign-in response the portal's own frontend receives
 *   (`/token/generatetokengooglesignin`), which students now get instead. Captured by the bookmarklet in
 *   `bookmarklet.js`; see that file for why it has to be captured off the wire rather than read back out of
 *   the portal's `localStorage`.
 *
 * Unlike jsjiit's version this is serializable - `toJSON`/`fromJSON` - so an app can persist a session and
 * restore it on next launch without going through sign-in again. Where it persists it is the app's business;
 * this library deliberately touches no storage.
 */
import { generateLocalName } from "./crypto.js";

/** Reads the `exp` claim out of a JWT without verifying it (the portal, not us, validates the token). */
function tokenExpiry(token) {
  try {
    const { exp } = JSON.parse(atob(token.split(".")[1]));
    return exp ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

export class WebPortalSession {
  constructor(fields) {
    this.institute = fields.institute;
    this.instituteid = fields.instituteid;
    this.memberid = fields.memberid;
    this.userid = fields.userid;
    this.token = fields.token;
    this.expiry = fields.expiry ?? tokenExpiry(fields.token);
    this.clientid = fields.clientid;
    this.membertype = fields.membertype;
    this.name = fields.name;
    this.enrollmentno = fields.enrollmentno;
    /** The portal's own `Username` field - what `/token/refreshTokenRequest` wants, not the enrollment no. */
    this.username = fields.username;
    /** When this session was obtained; `refreshTokenRequest` sends it back as `tokendate`. */
    this.tokenDate = fields.tokenDate ?? new Date().toISOString();
    this.raw_response = fields.raw_response;
  }

  /** From `/token/generatewebtoken`'s response (the username/password flow). */
  static fromLoginResponse(response) {
    const regdata = response.regdata;
    const institute = regdata.institutelist[0];
    return new WebPortalSession({
      institute: institute.label,
      instituteid: institute.value,
      memberid: regdata.memberid,
      userid: regdata.userid,
      token: regdata.token,
      clientid: regdata.clientid,
      membertype: regdata.membertype,
      name: regdata.name,
      enrollmentno: regdata.enrollmentno,
      username: regdata.Username ?? regdata.username,
      raw_response: response,
    });
  }

  /**
   * From `/token/generatetokengooglesignin`'s response. It is flatter than the password flow's - the
   * institute arrives as `label`/`value` at the top level rather than inside `regdata.institutelist`.
   */
  static fromGoogleResponse(response) {
    if (!response?.token) throw new Error("Google sign-in response carried no token.");
    return new WebPortalSession({
      institute: response.label ?? response.institute,
      instituteid: response.value ?? response.instituteid,
      memberid: response.memberid,
      userid: response.userid,
      token: response.token,
      clientid: response.clientid,
      membertype: response.membertype,
      name: response.name,
      enrollmentno: response.enrollmentno,
      username: response.Username ?? response.username,
      raw_response: response,
    });
  }

  /** Round-trips with `toJSON` - for restoring a persisted session. Returns null for anything unusable. */
  static fromJSON(obj) {
    if (!obj?.token) return null;
    return new WebPortalSession({ ...obj, expiry: obj.expiry ? new Date(obj.expiry) : null });
  }

  toJSON() {
    return {
      institute: this.institute,
      instituteid: this.instituteid,
      memberid: this.memberid,
      userid: this.userid,
      token: this.token,
      expiry: this.expiry ? this.expiry.toISOString() : null,
      clientid: this.clientid,
      membertype: this.membertype,
      name: this.name,
      enrollmentno: this.enrollmentno,
      username: this.username,
      tokenDate: this.tokenDate,
    };
  }

  /** True once the token's own `exp` claim is within `withinMs` (default a minute). */
  isExpiring(withinMs = 60_000) {
    return !!this.expiry && this.expiry.getTime() - Date.now() < withinMs;
  }

  async get_headers() {
    return { Authorization: `Bearer ${this.token}`, LocalName: await generateLocalName() };
  }
}
