import { describe, it, expect, vi, afterEach } from "vitest";
import { generateDateSeq, generateLocalName, serializePayload } from "../src/crypto.js";

describe("generateDateSeq", () => {
  afterEach(() => vi.useRealTimers());

  it("interleaves the date's digits around the weekday, as the portal's own frontend does", () => {
    // Fri 18 Sep 2026 -> day "18", month "09", year "26", weekday 5 -> "1 0 2 5 8 9 6"
    expect(generateDateSeq(new Date(2026, 8, 18))).toBe("1025896");
  });

  it("pads single-digit days and months", () => {
    // Fri 01 Jan 2027 -> day "01", month "01", year "27", weekday 5 -> "0 0 2 5 1 1 7"
    expect(generateDateSeq(new Date(2027, 0, 1))).toBe("0025117");
  });

  it("defaults to today", () => {
    vi.useFakeTimers().setSystemTime(new Date(2026, 8, 18));
    expect(generateDateSeq()).toBe(generateDateSeq(new Date(2026, 8, 18)));
  });
});

describe("generateLocalName", () => {
  it("is base64 of one AES-CBC block pair (16 plaintext bytes -> 32 bytes -> 44 chars)", async () => {
    const name = await generateLocalName();
    expect(name).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(atob(name)).toHaveLength(32);
  });

  it("differs every call - it carries a random nonce, not just the date", async () => {
    const names = await Promise.all(Array.from({ length: 5 }, () => generateLocalName()));
    expect(new Set(names).size).toBe(5);
  });

  it("changes with the date, since the key is derived from it", async () => {
    // Same nonce chars, different day: force randomness to be constant and compare.
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      expect(await generateLocalName(new Date(2026, 8, 18))).not.toBe(await generateLocalName(new Date(2026, 8, 19)));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("serializePayload", () => {
  it("encrypts deterministically for a given day, so the same payload signs the same way", async () => {
    const day = new Date(2026, 8, 18);
    const a = await serializePayload({ instituteid: "11IN1902J000003" }, day);
    const b = await serializePayload({ instituteid: "11IN1902J000003" }, day);
    expect(a).toBe(b);
  });

  it("produces different ciphertext on a different day", async () => {
    const payload = { instituteid: "11IN1902J000003" };
    expect(await serializePayload(payload, new Date(2026, 8, 18))).not.toBe(await serializePayload(payload, new Date(2026, 8, 19)));
  });

  it("pads to whole AES blocks", async () => {
    const out = await serializePayload({ a: 1 }, new Date(2026, 8, 18));
    expect(atob(out).length % 16).toBe(0);
  });
});
