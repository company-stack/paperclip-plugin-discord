import { describe, it, expect } from "vitest";
import { withRetry, throwOnRetryableStatus } from "../src/retry.js";

// ---------------------------------------------------------------------------
// Bug 2 — throwOnRetryableStatus unit tests
// ---------------------------------------------------------------------------

describe("throwOnRetryableStatus", () => {
  function fakeResponse(status: number): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
    } as unknown as Response;
  }

  it("does not throw for 200", () => {
    expect(() => throwOnRetryableStatus(fakeResponse(200))).not.toThrow();
  });

  it("does not throw for 400 (non-retryable error)", () => {
    expect(() => throwOnRetryableStatus(fakeResponse(400))).not.toThrow();
  });

  it("does not throw for 404 (non-retryable error)", () => {
    expect(() => throwOnRetryableStatus(fakeResponse(404))).not.toThrow();
  });

  it("throws for 429 with status and headers properties", () => {
    try {
      throwOnRetryableStatus(fakeResponse(429));
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(429);
      expect(err.headers).toBeDefined();
    }
  });

  it("throws for 500 with status property", () => {
    try {
      throwOnRetryableStatus(fakeResponse(500));
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(500);
    }
  });

  it("throws for 502 with status property", () => {
    try {
      throwOnRetryableStatus(fakeResponse(502));
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(502);
    }
  });

  it("throws for 503 with status property", () => {
    try {
      throwOnRetryableStatus(fakeResponse(503));
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(503);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — withRetry + throwOnRetryableStatus integration
// ---------------------------------------------------------------------------

describe("withRetry + throwOnRetryableStatus integration", () => {
  it("retries when callback uses throwOnRetryableStatus on 503 then succeeds", async () => {
    let attempt = 0;
    const result = await withRetry(
      async () => {
        attempt++;
        if (attempt === 1) {
          const resp = {
            ok: false,
            status: 503,
            headers: new Headers(),
          } as unknown as Response;
          throwOnRetryableStatus(resp);
          return resp;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
        } as unknown as Response;
      },
      { baseDelayMs: 10 },
    );
    expect(result.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it("does not retry for non-retryable status (403)", async () => {
    let attempt = 0;
    const result = await withRetry(
      async () => {
        attempt++;
        const resp = {
          ok: false,
          status: 403,
          headers: new Headers(),
        } as unknown as Response;
        throwOnRetryableStatus(resp); // no-op for 403
        return resp;
      },
      { baseDelayMs: 10 },
    );
    expect(attempt).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("exhausts retries and throws on persistent 500", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        async () => {
          attempt++;
          const resp = {
            ok: false,
            status: 500,
            headers: new Headers(),
          } as unknown as Response;
          throwOnRetryableStatus(resp);
          return resp;
        },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow("HTTP 500");
    expect(attempt).toBe(3); // 1 initial + 2 retries
  });
});
