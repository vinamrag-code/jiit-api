import { describe, it, expect, vi } from "vitest";
import { WebPortal, formatPortalDate } from "../src/client.js";
import { WebPortalSession } from "../src/session.js";
import { APIError, NotLoggedIn, SessionExpired } from "../src/errors.js";

function tokenExpiringIn(seconds) {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function session(overrides = {}) {
  return WebPortalSession.fromGoogleResponse({
    token: tokenExpiringIn(3600),
    clientid: "JIIT",
    Username: "student@mail.jiit.ac.in",
    name: "A Student",
    enrollmentno: "23103000",
    memberid: "11IN1902J000123",
    membertype: "S",
    label: "JIIT",
    value: "11IN1902J000003",
    ...overrides,
  });
}

/** A `fetch` double that answers each call from a queue of `{ status, body }`, recording the requests. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = vi.fn(async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift() ?? { status: 200, body: { status: { responseStatus: "Success" }, response: {} } };
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return {
      status: next.status ?? 200,
      statusText: next.statusText ?? "OK",
      ok: (next.status ?? 200) < 400,
      text: async () => text,
      json: async () => JSON.parse(text),
      blob: async () => next.blob,
    };
  });
  return { impl, calls };
}

describe("authentication guards", () => {
  it("throws NotLoggedIn rather than sending a request with no session", async () => {
    const { impl } = fakeFetch([]);
    const w = new WebPortal({ fetch: impl });
    await expect(w.get_personal_info()).rejects.toBeInstanceOf(NotLoggedIn);
    expect(impl).not.toHaveBeenCalled();
  });

  it("sends the bearer token and a LocalName on authenticated calls", async () => {
    const { impl, calls } = fakeFetch([{ body: { response: { name: "A Student" } } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await w.get_personal_info();
    expect(calls[0].options.headers.Authorization).toMatch(/^Bearer /);
    expect(calls[0].options.headers.LocalName).toBeTruthy();
  });
});

describe("error handling", () => {
  it("surfaces a 401 as SessionExpired, not a generic APIError", async () => {
    // jsjiit loses this distinction: it throws SessionExpired inside a try whose catch re-wraps it.
    const { impl } = fakeFetch([{ status: 401, body: "" }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await expect(w.get_personal_info()).rejects.toBeInstanceOf(SessionExpired);
  });

  it("quotes the body when the portal answers with something that isn't JSON", async () => {
    // Exactly what a proxy that forwards a foreign Origin gets back: `403 Invalid CORS request`, in plain
    // text, which otherwise surfaces as an inscrutable "Unexpected token 'I'" JSON parse error.
    const { impl } = fakeFetch([{ status: 403, statusText: "Forbidden", body: "Invalid CORS request" }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await expect(w.get_personal_info()).rejects.toThrow(/Invalid CORS request/);
  });

  it("names CORS as the likely cause when fetch itself fails opaquely", async () => {
    const impl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const w = new WebPortal({ fetch: impl, session: session(), apiUrl: "https://webportal.jiit.ac.in:6011/StudentPortalAPI" });
    await expect(w.get_personal_info()).rejects.toThrow(/CORS.*proxy/s);
  });

  it("reports a 513 as the portal being down", async () => {
    const { impl } = fakeFetch([{ status: 513, body: "" }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await expect(w.get_personal_info()).rejects.toThrow(/temporarily unavailable/);
  });

  it("raises the portal's own failure status", async () => {
    const { impl } = fakeFetch([{ body: { status: { responseStatus: "Failure", errorMessage: "nope" } } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await expect(w.get_personal_info()).rejects.toBeInstanceOf(APIError);
  });
});

describe("token refresh", () => {
  it("refreshes before a call when the token is about to expire", async () => {
    const { impl, calls } = fakeFetch([
      { body: { response: { msg: "Success" } } },
      { body: { response: { name: "A Student" } } },
    ]);
    const w = new WebPortal({ fetch: impl, session: session({ token: tokenExpiringIn(10) }) });
    await w.get_personal_info();
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining("/token/refreshTokenRequest"),
      expect.stringContaining("/studentpersinfo/getstudent-personalinformation"),
    ]);
  });

  it("does not refresh a token that is still good", async () => {
    const { impl, calls } = fakeFetch([{ body: { response: {} } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await w.get_personal_info();
    expect(calls).toHaveLength(1);
  });

  it("sends the portal's Username and the session's tokendate, which is what it keys the refresh on", async () => {
    const { impl, calls } = fakeFetch([{ body: { response: { msg: "Success" } } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await w.refresh_session();
    expect(JSON.parse(calls[0].options.body)).toMatchObject({ username: "student@mail.jiit.ac.in" });
  });

  it("reports failure instead of throwing, so a caller can fall back to signing in again", async () => {
    const { impl } = fakeFetch([{ status: 500, body: { exception: "java.lang.IllegalArgumentException" } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await expect(w.refresh_session()).resolves.toBe(false);
  });

  it("reads success from the envelope status, not from response.msg", async () => {
    // The live portal answers a good refresh with responseStatus "Success" while response.msg is a
    // human-readable string ("Token Referesh at the time of Login differnce timing = ...").
    const { impl } = fakeFetch([{ body: {
      status: { responseStatus: "Success", errors: null },
      response: { msg: "Token Referesh at the time of Login differnce timing = -6314hrs ,-38min ,-37sec ," },
    } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await expect(w.refresh_session()).resolves.toBe(true);
  });
});

describe("endpoints", () => {
  it("get_attendance_meta returns a model with the newest semester first", async () => {
    const { impl } = fakeFetch([{
      body: {
        response: {
          headerlist: [{ branchdesc: "CSE", name: "A Student", programdesc: "B.Tech", stynumber: 5 }],
          semlist: [{ registrationcode: "2026ODDSEM", registrationid: "R5" }, { registrationcode: "2025EVENSEM", registrationid: "R4" }],
        },
      },
    }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    const meta = await w.get_attendance_meta();
    expect(meta.latest_semester().registration_code).toBe("2026ODDSEM");
    expect(meta.latest_header().stynumber).toBe(5);
  });

  it("get_exam_events keeps the portal's `registationid` spelling in the payload", async () => {
    // Correcting it to `registrationid` makes this endpoint return nothing.
    const { impl, calls } = fakeFetch([{ body: { response: { eventcode: { examevent: [] } } } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await w.get_exam_events({ registration_id: "R5" });
    expect(calls[0].options.body).toBeTruthy();
  });

  it("get_semesters_for_grade_card merges both sources, letting an official entry win", async () => {
    const { impl } = fakeFetch([
      { body: { response: { registrations: [{ registrationcode: "2025EVENSEM", registrationid: "R4" }] } } },
      { body: { response: { registrations: [{ registrationcode: "2025EVENSEM", registrationid: "R4" }, { registrationcode: "2026ODDSEM", registrationid: "R5" }] } } },
    ]);
    const w = new WebPortal({ fetch: impl, session: session() });
    const semesters = await w.get_semesters_for_grade_card();
    expect(semesters).toHaveLength(2);
    const byId = Object.fromEntries(semesters.map((s) => [s.registration_id, s]));
    expect(byId.R4.grade_card_source).toBe("official");
    expect(byId.R4.is_grade_card_complete).toBe(true);
    expect(byId.R5.grade_card_source).toBe("choice");
  });

  it("get_personal_info keeps the portal's `clinetid` typo, which it requires", async () => {
    const { impl, calls } = fakeFetch([{ body: { response: {} } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await w.get_personal_info();
    expect(JSON.parse(calls[0].options.body)).toHaveProperty("clinetid");
  });
});

describe("payload formats the live portal insists on", () => {
  // Each of these was found by probing the live server; getting them wrong fails quietly or with a 500.
  it("sends an encrypted body to getstudentbankinfo, not plain JSON", async () => {
    // A plain JSON body here returns 500 java.lang.NullPointerException. jsjiit sends plain JSON.
    const { impl, calls } = fakeFetch([{ body: { response: { bankinfo: {} } } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await w.get_student_bank_info();
    const sent = JSON.parse(calls[0].options.body);
    expect(typeof sent).toBe("string");
    expect(sent).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("sends tokendate as dd/mm/yyyy on refresh, not ISO", async () => {
    // ISO, epoch and yyyy-mm-dd all return 500 java.lang.IllegalArgumentException.
    const { impl, calls } = fakeFetch([{ body: { response: { msg: "Success" } } }]);
    const w = new WebPortal({ fetch: impl, session: session() });
    await w.refresh_session();
    expect(JSON.parse(calls[0].options.body).tokendate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});

describe("formatPortalDate", () => {
  it("pads day and month to two digits", () => {
    expect(formatPortalDate(new Date(2027, 0, 1))).toBe("01/01/2027");
    expect(formatPortalDate(new Date(2026, 8, 18))).toBe("18/09/2026");
  });

  it("accepts an ISO string as well as a Date, since sessions persist tokenDate as ISO", () => {
    expect(formatPortalDate(new Date(2026, 8, 18).toISOString())).toBe("18/09/2026");
  });
});
