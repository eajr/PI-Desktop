import { describe, expect, it, vi } from "vitest";
import {
  createJevClassifierTool,
  type JevAuthorization,
  type JevAuthorize,
} from "./jev-classifier-tool.js";

const API_KEY = "jev-fixture-secret-do-not-leak";

const params = {
  state: { message: "The change works." },
  questions: {
    category: {
      type: "choice",
      instructions: "Classify the message.",
      criteria: { approval: "Approves", correction: "Requests a correction" },
    },
    satisfaction: {
      type: "score",
      instructions: "Score satisfaction.",
      criteria: ["low", "medium", "high"],
    },
    approved: {
      type: "bool",
      instructions: "Does the user approve?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
};

const approve: JevAuthorize = async () => ({ ok: true });

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      answers: {
        category: {
          type: "choice",
          choice: "approval",
          probabilities: { approval: 0.9, correction: 0.1 },
          confidence: 0.9,
        },
        satisfaction: { type: "score", score: 2, confidence: 0.8 },
        approved: { type: "noul", noul: 0.95 },
      },
      usage: { input_tokens: 12, output_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("JevClassify", () => {
  it("sends the typed state to TypeSafe and returns structured answers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => successResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await createJevClassifierTool(API_KEY, approve).execute(
        "call-1",
        params,
      );

      expect(result.isError).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${API_KEY}`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "jev-latest",
        state: params.state,
        questions: {
          ...params.questions,
          approved: {
            ...params.questions.approved,
            type: "noul",
          },
        },
      });
      expect(result.details).toMatchObject({
        answers: {
          category: { type: "choice", choice: "approval" },
          satisfaction: { type: "score", score: 2 },
          approved: { type: "bool", probability: 0.95 },
        },
        usage: { input: 12, output: 4, totalTokens: 16 },
      });
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects malformed and oversized inputs before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => successResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tool = createJevClassifierTool(API_KEY, approve);
      const malformed = await tool.execute("call-bad", {
        ...params,
        state: { score: Number.NaN },
      });
      const oversized = await tool.execute("call-large", {
        ...params,
        state: { message: "x".repeat(24 * 1024) },
      });

      expect(malformed.isError).toBe(true);
      expect(oversized.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("observes cancellation and redacts credentials from provider errors", async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          markStarted();
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const pending = createJevClassifierTool(API_KEY, approve).execute(
        "call-abort",
        params,
        controller.signal,
      );
      await requestStarted;
      controller.abort();
      const cancelled = await pending;
      expect(cancelled.isError).toBe(true);
      expect(cancelled.details).toMatchObject({ errorCode: "JEV_ABORTED" });

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () =>
          new Response(API_KEY, { status: 401 }),
        ),
      );
      const failed = await createJevClassifierTool(API_KEY, approve).execute(
        "call-error",
        params,
      );
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).not.toContain(API_KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enforces the bounded provider timeout", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    let markStarted: () => void = () => undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            markStarted();
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    try {
      const pending = createJevClassifierTool(API_KEY, approve).execute(
        "call-timeout",
        params,
      );
      await requestStarted;
      expect(timeoutSpy).toHaveBeenCalledWith(45_000);
      timeout.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ errorCode: "JEV_ABORTED" });
    } finally {
      timeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not call TypeSafe until the host gate approves", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => successResponse());
    vi.stubGlobal("fetch", fetchMock);
    let approveCall: (value: JevAuthorization) => void = () => undefined;
    const authorize = vi.fn<JevAuthorize>(
      () =>
        new Promise<JevAuthorization>((resolve) => {
          approveCall = resolve;
        }),
    );
    try {
      const pending = createJevClassifierTool(API_KEY, authorize).execute(
        "call-gated",
        params,
      );
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
      expect(authorize.mock.calls[0][0]).toMatchObject({
        toolCallId: "call-gated",
        context: { state: params.state },
      });
      // Give any premature request a chance to start.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchMock).not.toHaveBeenCalled();

      approveCall({ ok: true });
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("makes no network call when the user denies or the gate fails", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => successResponse());
    vi.stubGlobal("fetch", fetchMock);
    try {
      const denied = await createJevClassifierTool(API_KEY, async () => ({
        ok: false,
        errorCode: "TOOL_DENIED",
        denied: true,
      })).execute("call-denied", params);
      expect(denied.isError).toBe(true);
      expect(denied.details).toMatchObject({
        errorCode: "TOOL_DENIED",
        denied: true,
      });

      const failed = await createJevClassifierTool(API_KEY, async () => {
        throw new Error(`host unavailable ${API_KEY}`);
      }).execute("call-gate-error", params);
      expect(failed.isError).toBe(true);
      expect(failed.details).toMatchObject({
        errorCode: "JEV_AUTHORIZATION_FAILED",
      });
      expect(JSON.stringify(failed)).not.toContain(API_KEY);

      const controller = new AbortController();
      const cancelled = await createJevClassifierTool(API_KEY, async () => {
        controller.abort();
        return { ok: true };
      }).execute("call-cancelled", params, controller.signal);
      expect(cancelled.details).toMatchObject({ errorCode: "JEV_ABORTED" });

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
