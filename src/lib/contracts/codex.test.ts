import { describe, expect, it } from "vitest"

import {
  CodexContractError,
  codexCommands,
  parseAcceptedResponse,
  parseAttachmentRegistrationResponse,
  parseCodexCommandError,
  parseCodexDiagnostic,
  parseCodexEvent,
  parseCodexResponse,
  parseReviewResponse,
  parseThreadListResponse,
  parseThreadResponse,
  parseTurnResponse,
  parseWorkspaceRegistration,
} from "@/lib/contracts/codex"
import attachmentFixture from "@/test/fixtures/codex-attachments.v1.json"
import fixture from "@/test/fixtures/codex-runtime.v1.json"

describe("Codex runtime contract", () => {
  it("parses every response and event in the cross-language fixture", () => {
    expect(parseCodexDiagnostic(fixture.diagnostic)).toEqual(fixture.diagnostic)
    expect(parseThreadListResponse(fixture.threadList)).toEqual(
      fixture.threadList,
    )
    expect(parseThreadResponse(fixture.thread)).toEqual(fixture.thread)
    expect(parseTurnResponse(fixture.turn)).toEqual(fixture.turn)
    expect(parseReviewResponse(fixture.review)).toEqual(fixture.review)
    expect(parseAcceptedResponse(fixture.accepted)).toEqual(fixture.accepted)
    expect(parseCodexCommandError(fixture.commandError)).toEqual(
      fixture.commandError,
    )
    expect(fixture.events.map(parseCodexEvent)).toEqual(fixture.events)
  })

  it("routes each command to its exact response parser", () => {
    expect(
      parseCodexResponse(codexCommands.connect, fixture.diagnostic),
    ).toEqual(fixture.diagnostic)
    expect(
      parseCodexResponse(codexCommands.threadList, fixture.threadList),
    ).toEqual(fixture.threadList)
    expect(parseCodexResponse(codexCommands.turnStart, fixture.turn)).toEqual(
      fixture.turn,
    )
    expect(
      parseCodexResponse(codexCommands.answerFallbackDecision, fixture.turn),
    ).toEqual(fixture.turn)
    expect(
      parseCodexResponse(
        codexCommands.pickAttachments,
        attachmentFixture.registration,
      ),
    ).toEqual(attachmentFixture.registration)
    const workspace = {
      schemaVersion: 1,
      workspaceId: "workspace-fixture",
      alias: "Fixture repository",
      preflight: {
        gitRepository: true,
        ownedByCurrentUser: true,
        writable: true,
      },
    }
    expect(parseWorkspaceRegistration(workspace)).toEqual(workspace)
    expect(parseCodexResponse(codexCommands.pickWorkspace, workspace)).toEqual(
      workspace,
    )
  })

  it("rejects future schemas and unknown fields", () => {
    expect(() =>
      parseCodexEvent({ ...fixture.events[0], schemaVersion: 2 }),
    ).toThrow(CodexContractError)
    expect(() =>
      parseCodexEvent({ ...fixture.events[0], rawPayload: {} }),
    ).toThrow(CodexContractError)
    expect(() =>
      parseCodexDiagnostic({ ...fixture.diagnostic, serviceTier: "fast" }),
    ).toThrow(CodexContractError)
  })

  it("keeps attachment paths relative and rejects unsafe native output", () => {
    expect(
      parseAttachmentRegistrationResponse(attachmentFixture.registration),
    ).toEqual(attachmentFixture.registration)
    expect(() =>
      parseAttachmentRegistrationResponse({
        ...attachmentFixture.registration,
        items: [
          {
            ...attachmentFixture.registration.items[0],
            relativePath: "/Users/private/demo.png",
          },
        ],
      }),
    ).toThrow(CodexContractError)
    expect(() =>
      parseAttachmentRegistrationResponse({
        ...attachmentFixture.registration,
        items: [
          {
            ...attachmentFixture.registration.items[0],
            sizeBytes: 25 * 1024 * 1024 + 1,
          },
        ],
      }),
    ).toThrow(CodexContractError)
  })

  it("rejects raw reasoning and private paths before UI state", () => {
    const completed = fixture.events[2]
    expect(() =>
      parseCodexEvent({
        ...completed,
        payload: { ...completed?.payload, reasoning: "hidden chain" },
      }),
    ).toThrow(CodexContractError)
    expect(() =>
      parseCodexEvent({
        ...completed,
        payload: {
          itemHandle: "item_handle_fixture",
          text: "Read /Users/private/project/secret.txt",
        },
      }),
    ).toThrow(CodexContractError)
    for (const privateValue of [
      '"auth_cookie" = "private-cookie"',
      "sessionid: private-session",
      "set-cookie: private-cookie",
      "/Volumes/Private/project.txt",
      "/Library/Application Support/private.txt",
      "/Applications/Private.app/Contents",
    ]) {
      expect(() =>
        parseCodexEvent({
          ...completed,
          payload: {
            itemHandle: "item_handle_fixture",
            text: privateValue,
          },
        }),
      ).toThrow(CodexContractError)
    }
  })

  it("enforces discriminated pending request invariants", () => {
    const pending = fixture.events[1]
    if (pending?.kind !== "pending_request") throw new Error("fixture")
    const base = pending.payload.request
    const userInput = {
      ...base,
      kind: "user_input",
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Choose one",
          options: [
            { id: "a", label: "A", description: "First" },
            { id: "b", label: "B", description: "Second" },
          ],
        },
      ],
      allowedDecisions: [],
      approvalContext: null,
    }
    expect(
      parseCodexEvent({
        ...pending,
        payload: { request: userInput },
      }),
    ).toMatchObject({ kind: "pending_request" })
    expect(
      parseCodexEvent({
        ...pending,
        payload: {
          request: {
            ...userInput,
            responseKind: "fallback_decision",
            operation: "decision_fallback",
            questions: [userInput.questions[0]],
          },
        },
      }),
    ).toMatchObject({
      kind: "pending_request",
      payload: {
        request: {
          responseKind: "fallback_decision",
          operation: "decision_fallback",
        },
      },
    })
    expect(() =>
      parseCodexEvent({
        ...pending,
        payload: {
          request: {
            ...userInput,
            responseKind: "fallback_decision",
          },
        },
      }),
    ).toThrow(CodexContractError)
    expect(() =>
      parseCodexEvent({
        ...pending,
        payload: {
          request: {
            ...userInput,
            questions: [
              {
                ...userInput.questions[0],
                options: [userInput.questions[0]?.options[0]],
              },
            ],
          },
        },
      }),
    ).toThrow(CodexContractError)
    expect(() =>
      parseCodexEvent({
        ...pending,
        payload: {
          request: {
            ...base,
            questions: userInput.questions,
          },
        },
      }),
    ).toThrow(CodexContractError)
    expect(() =>
      parseCodexEvent({
        ...pending,
        payload: {
          request: { ...userInput, allowedDecisions: ["reject"] },
        },
      }),
    ).toThrow(CodexContractError)
  })

  it("rejects any model substitution", () => {
    expect(() =>
      parseThreadResponse({ ...fixture.thread, model: "gpt-5.6" }),
    ).toThrow(CodexContractError)
    expect(() =>
      parseThreadResponse({ ...fixture.thread, generation: 0 }),
    ).toThrow(CodexContractError)
  })

  it("accepts a sanitized reroute target only as a violation event", () => {
    expect(
      parseCodexEvent({
        ...fixture.events[0],
        eventId: "event-model-violation",
        kind: "model_violation",
        payload: {
          fromModel: "gpt-5.6-sol",
          toModel: "unexpected-model",
        },
      }),
    ).toMatchObject({
      kind: "model_violation",
      payload: { toModel: "unexpected-model" },
    })
  })
})
