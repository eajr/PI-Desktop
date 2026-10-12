import { createModels } from "@earendil-works/pi-ai/models";
import { TYPESAFE_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/typesafe.models";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import type {
  ClassifierContext,
  ClassifierQuestion,
  JsonObject,
  JsonValue,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const MAX_CONTEXT_BYTES = 24 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_QUESTIONS = 16;
const MAX_CRITERIA = 32;
const MAX_TEXT_LENGTH = 1_200;

const models = createModels();
models.setProvider(typesafeProvider());

const jevModel = TYPESAFE_CLASSIFIER_MODELS["jev-latest"];

const choiceQuestionSchema = Type.Object(
  {
    type: Type.Literal("choice"),
    instructions: Type.String(),
    criteria: Type.Record(Type.String(), Type.String()),
  },
  { additionalProperties: false },
);
const scoreQuestionSchema = Type.Object(
  {
    type: Type.Literal("score"),
    instructions: Type.String(),
    criteria: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
const boolQuestionSchema = Type.Object(
  {
    type: Type.Literal("bool"),
    instructions: Type.String(),
    criteria: Type.Object(
      { true: Type.String(), false: Type.String() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  );
}

function boundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_TEXT_LENGTH
  );
}

function parseQuestion(value: unknown): ClassifierQuestion | undefined {
  if (!isRecord(value) || !boundedText(value.instructions)) return undefined;
  if (value.type === "choice" && isRecord(value.criteria)) {
    const entries = Object.entries(value.criteria);
    if (
      entries.length < 2 ||
      entries.length > MAX_CRITERIA ||
      entries.some(([label, description]) =>
        !boundedText(label) || !boundedText(description),
      )
    ) {
      return undefined;
    }
    return {
      type: "choice",
      instructions: value.instructions,
      criteria: Object.fromEntries(entries) as Record<string, string>,
    };
  }
  if (value.type === "score" && Array.isArray(value.criteria)) {
    if (
      value.criteria.length < 2 ||
      value.criteria.length > MAX_CRITERIA ||
      value.criteria.some((criterion) => !boundedText(criterion))
    ) {
      return undefined;
    }
    return {
      type: "score",
      instructions: value.instructions,
      criteria: value.criteria as string[],
    };
  }
  if (
    value.type === "bool" &&
    isRecord(value.criteria) &&
    boundedText(value.criteria.true) &&
    boundedText(value.criteria.false) &&
    Object.keys(value.criteria).length === 2
  ) {
    return {
      type: "bool",
      instructions: value.instructions,
      criteria: { true: value.criteria.true, false: value.criteria.false },
    };
  }
  return undefined;
}

function parseContext(value: unknown): ClassifierContext | undefined {
  if (!isRecord(value) || !isRecord(value.state) || !isRecord(value.questions)) {
    return undefined;
  }
  if (!Object.values(value.state).every((entry) => isJsonValue(entry))) {
    return undefined;
  }
  const questionEntries = Object.entries(value.questions);
  if (
    questionEntries.length === 0 ||
    questionEntries.length > MAX_QUESTIONS ||
    questionEntries.some(([id]) => !boundedText(id) || id.length > 96)
  ) {
    return undefined;
  }
  const questions = Object.create(null) as Record<string, ClassifierQuestion>;
  for (const [id, rawQuestion] of questionEntries) {
    const question = parseQuestion(rawQuestion);
    if (!question) return undefined;
    questions[id] = question;
  }
  const context: ClassifierContext = {
    state: value.state as JsonObject,
    questions,
  };
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_CONTEXT_BYTES) {
    return undefined;
  }
  return context;
}

export const JEV_CLASSIFY_TOOL_NAME = "JevClassify";

/** Outcome of the host permission gate for one JevClassify call. */
export type JevAuthorization =
  | { ok: true }
  | { ok: false; errorCode: string; denied: boolean };

/**
 * Ask the host to authorize sending `context` to TypeSafe. Resolves only after
 * the host decided (an `ask`-mode card waits for the user). Nothing leaves the
 * machine unless this resolves `{ ok: true }`.
 */
export type JevAuthorize = (input: {
  toolCallId: string;
  context: ClassifierContext;
  signal?: AbortSignal;
}) => Promise<JevAuthorization>;

/**
 * Agent-only, deferred call to pi-ai's TypeSafe System One classifier. Every
 * call passes the host-core permission gate before any network request.
 */
export function createJevClassifierTool(
  apiKey: string,
  authorize: JevAuthorize,
): AgentTool {
  return {
    name: JEV_CLASSIFY_TOOL_NAME,
    label: "Jev classify",
    description:
      "Classify JSON state with TypeSafe Jev and return structured choice, score, or boolean answers. The state and questions are sent directly to TypeSafe; include only information the user has approved for that service.",
    parameters: Type.Object(
      {
        state: Type.Record(Type.String(), Type.Any()),
        questions: Type.Record(
          Type.String(),
          Type.Union([
            choiceQuestionSchema,
            scoreQuestionSchema,
            boolQuestionSchema,
          ]),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (toolCallId, rawParams, signal) => {
      const context = parseContext(rawParams);
      if (!context) {
        return {
          content: [
            {
              type: "text",
              text: "JevClassify requires a JSON object state and 1–16 valid structured questions; the total input must be at most 24 KiB.",
            },
          ],
          details: { errorCode: "JEV_INVALID_ARGUMENT" },
          isError: true,
        };
      }
      let authorization: JevAuthorization;
      try {
        authorization = await authorize({ toolCallId, context, signal });
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error))
          .replaceAll(apiKey, "[redacted]")
          .slice(0, 1_000);
        return {
          content: [
            {
              type: "text",
              text: `JevClassify could not be authorized; nothing was sent to TypeSafe: ${message}`,
            },
          ],
          details: { errorCode: "JEV_AUTHORIZATION_FAILED" },
          isError: true,
        };
      }
      if (!authorization.ok || signal?.aborted) {
        const aborted = signal?.aborted === true ||
          (!authorization.ok && authorization.errorCode === "TOOL_ABORTED");
        const denied = !aborted && !authorization.ok && authorization.denied;
        return {
          content: [
            {
              type: "text",
              text: aborted
                ? "JevClassify was cancelled before anything was sent to TypeSafe."
                : denied
                  ? "JevClassify was denied; nothing was sent to TypeSafe."
                  : "JevClassify was not authorized; nothing was sent to TypeSafe.",
            },
          ],
          details: {
            errorCode: aborted
              ? "JEV_ABORTED"
              : authorization.ok
                ? "JEV_AUTHORIZATION_FAILED"
                : authorization.errorCode,
            ...(denied ? { denied: true } : {}),
          },
          isError: true,
        };
      }
      const timeoutSignal = AbortSignal.timeout(45_000);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      const result = await models.classify(jevModel, context, {
        apiKey,
        signal: requestSignal,
        timeoutMs: 45_000,
        maxRetries: 1,
      });
      if (result.stopReason !== "stop") {
        const errorMessage = (result.errorMessage ?? "Request did not complete")
          .replaceAll(apiKey, "[redacted]")
          .slice(0, 1_000);
        return {
          content: [{ type: "text", text: `Jev classification failed: ${errorMessage}` }],
          details: {
            errorCode:
              result.stopReason === "aborted"
                ? "JEV_ABORTED"
                : "JEV_REQUEST_FAILED",
          },
          isError: true,
        };
      }
      const answer = {
        answers: result.answers,
        ...(result.usage ? { usage: result.usage } : {}),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(answer, null, 2) }],
        details: answer,
      };
    },
  };
}
