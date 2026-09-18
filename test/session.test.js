import { describe, it, expect } from "vitest";
import { WebPortalSession } from "../src/session.js";

/** A JWT whose `exp` claim is `expSeconds`. Only the payload segment is ever read. */
function tokenExpiringAt(expSeconds) {
  const payload = btoa(JSON.stringify({ exp: expSeconds })).replace(/=+$/, "");
  return `header.${payload}.signature`;
}

const googleResponse = {
  token: tokenExpiringAt(Math.floor(Date.now() / 1000) + 3600),
  clientid: "JIIT",
  Username: "student@mail.jiit.ac.in",
  name: "A Student",
  enrollmentno: "23103000",
  memberid: "11IN1902J000123",
  userid: "9999",
  membertype: "S",
  label: "JIIT",
  value: "11IN1902J000003",
};

describe("WebPortalSession.fromGoogleResponse", () => {
  it("maps the flat label/value pair onto institute/instituteid", () => {
    const s = WebPortalSession.fromGoogleResponse(googleResponse);
    expect(s.institute).toBe("JIIT");
    expect(s.instituteid).toBe("11IN1902J000003");
  });

  it("keeps memberid - the field the portal's own localStorage omits, which is why we capture the response", () => {
    expect(WebPortalSession.fromGoogleResponse(googleResponse).memberid).toBe("11IN1902J000123");
  });

  it("takes the portal's `Username` as the refresh username, not the enrollment number", () => {
    const s = WebPortalSession.fromGoogleResponse(googleResponse);
    expect(s.username).toBe("student@mail.jiit.ac.in");
    expect(s.username).not.toBe(s.enrollmentno);
  });

  it("reads the expiry out of the token's exp claim", () => {
    const s = WebPortalSession.fromGoogleResponse(googleResponse);
    expect(s.expiry.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a response with no token", () => {
    expect(() => WebPortalSession.fromGoogleResponse({ name: "A Student" })).toThrow(/no token/i);
  });
});

describe("WebPortalSession.fromLoginResponse", () => {
  it("reads the institute out of regdata.institutelist, where the password flow nests it", () => {
    const s = WebPortalSession.fromLoginResponse({
      regdata: {
        institutelist: [{ label: "JIIT", value: "11IN1902J000003" }],
        memberid: "11IN1902J000123",
        token: googleResponse.token,
        clientid: "JIIT",
        membertype: "S",
        name: "A Student",
        enrollmentno: "23103000",
      },
    });
    expect(s.institute).toBe("JIIT");
    expect(s.instituteid).toBe("11IN1902J000003");
    expect(s.memberid).toBe("11IN1902J000123");
  });
});

describe("persistence", () => {
  it("round-trips through JSON", () => {
    const original = WebPortalSession.fromGoogleResponse(googleResponse);
    const restored = WebPortalSession.fromJSON(JSON.parse(JSON.stringify(original)));
    expect(restored.toJSON()).toEqual(original.toJSON());
    expect(restored.expiry.getTime()).toBe(original.expiry.getTime());
  });

  it("returns null rather than a broken session when there's no token to restore", () => {
    expect(WebPortalSession.fromJSON(null)).toBeNull();
    expect(WebPortalSession.fromJSON({})).toBeNull();
  });

  it("does not serialize raw_response - it's large and nothing reads it back", () => {
    const s = WebPortalSession.fromGoogleResponse(googleResponse);
    expect(s.raw_response).toBeDefined();
    expect(s.toJSON()).not.toHaveProperty("raw_response");
  });
});

describe("isExpiring", () => {
  it("is true within the window and false outside it", () => {
    const soon = WebPortalSession.fromGoogleResponse({ ...googleResponse, token: tokenExpiringAt(Math.floor(Date.now() / 1000) + 30) });
    const later = WebPortalSession.fromGoogleResponse(googleResponse);
    expect(soon.isExpiring()).toBe(true);
    expect(later.isExpiring()).toBe(false);
  });

  it("is false when the token carried no readable expiry, rather than refreshing on every call", () => {
    const s = WebPortalSession.fromGoogleResponse({ ...googleResponse, token: "not.a.jwt" });
    expect(s.expiry).toBeNull();
    expect(s.isExpiring()).toBe(false);
  });
});

describe("get_headers", () => {
  it("carries the bearer token and a fresh LocalName", async () => {
    const s = WebPortalSession.fromGoogleResponse(googleResponse);
    const headers = await s.get_headers();
    expect(headers.Authorization).toBe(`Bearer ${googleResponse.token}`);
    expect(headers.LocalName).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
