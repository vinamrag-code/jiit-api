import { describe, it, expect } from "vitest";
import { bookmarkletScript, buildBookmarklet, parseImportParams } from "../src/bookmarklet.js";

describe("bookmarkletScript", () => {
  const script = bookmarkletScript("https://jpwebportal.example");

  it("patches XMLHttpRequest, not just fetch", () => {
    // The portal's frontend is Angular; HttpClient uses XHR, so a fetch-only patch never fires.
    expect(script).toContain("XMLHttpRequest.prototype.open");
    expect(script).toContain("window.fetch");
  });

  it("matches the endpoint with separators and case stripped, covering both spellings seen live", () => {
    const match = /replace\(\/\[-_\]\/g, ''\)\.indexOf\('generatetokengooglesignin'\)/;
    expect(script).toMatch(match);
    expect(script).toContain("toLowerCase()");
  });

  it("redirects to the given origin", () => {
    expect(script).toContain('"https://jpwebportal.example"');
    expect(bookmarkletScript("https://jpwebportal.example", "/#/custom")).toContain('"/#/custom"');
  });

  it("guards against being installed twice", () => {
    expect(script).toContain("__jiitCapture");
  });

  it("is valid JavaScript", () => {
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("buildBookmarklet", () => {
  it("is a javascript: URI with nothing that would break a bookmark's URL field", () => {
    const uri = buildBookmarklet("https://jpwebportal.example");
    expect(uri.startsWith("javascript:")).toBe(true);
    expect(uri).not.toMatch(/[\s"<>]/);
  });
});

describe("parseImportParams", () => {
  const expected = { token: "abc", memberid: "M1" };

  it("accepts a URLSearchParams", () => {
    expect(parseImportParams(new URLSearchParams("token=abc&memberid=M1"))).toEqual(expected);
  });

  it("accepts a query string, with or without the leading ?", () => {
    expect(parseImportParams("?token=abc&memberid=M1")).toEqual(expected);
    expect(parseImportParams("token=abc&memberid=M1")).toEqual(expected);
  });

  it("accepts a full redirect URL", () => {
    expect(parseImportParams("https://jpwebportal.example/#/import-session?token=abc&memberid=M1")).toEqual(expected);
  });

  it("accepts a plain object, copying rather than aliasing it", () => {
    const source = { ...expected };
    const parsed = parseImportParams(source);
    parsed.token = "changed";
    expect(source.token).toBe("abc");
  });
});
