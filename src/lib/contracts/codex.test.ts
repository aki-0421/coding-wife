import { describe, expect, it } from "vitest"

import {
  CodexContractError,
  codexCommands,
  parseAcceptedResponse,
  parseCodexDiagnostic,
  parseCodexEvent,
  parseCodexResponse,
  parseReviewResponse,
  parseThreadListResponse,
  parseThreadResponse,
  parseTurnResponse,
} from "@/lib/contracts/codex"
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
  })

  it("rejects any model substitution", () => {
    expect(() =>
      parseThreadResponse({ ...fixture.thread, model: "gpt-5.6" }),
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
