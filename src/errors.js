/** Error types the client throws. Ported from jsjiit, whose names the JP WebPortal app already catches by. */

export class APIError extends Error {
  constructor(message) {
    super(message);
    this.name = "APIError";
  }
}

export class LoginError extends APIError {
  constructor(message) {
    super(message);
    this.name = "LoginError";
  }
}

export class AccountAPIError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccountAPIError";
  }
}

export class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionError";
  }
}

/** The portal answered 401 - the bearer token is no longer accepted. */
export class SessionExpired extends SessionError {
  constructor(message) {
    super(message);
    this.name = "SessionExpired";
  }
}

/** A `WebPortal` method that needs a session was called before one was set. */
export class NotLoggedIn extends SessionError {
  constructor(message = "Not logged in - set a session first (see importSession/restoreSession/student_login).") {
    super(message);
    this.name = "NotLoggedIn";
  }
}
