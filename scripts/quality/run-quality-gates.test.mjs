import assert from "node:assert/strict"
import test from "node:test"

import { executeGateSequence, QUALITY_GATES } from "./run-quality-gates.mjs"

const expectedGateOrder = [
  "format",
  "dependency-licenses",
  "clean-checkout",
  "typecheck",
  "frontend-build",
  "live2d-inventory",
  "rust-format",
  "rust-clippy",
  "rust-test",
  "agent-docs",
  "tauri-build",
  "repository-diff",
]

test("submission gates remain complete and sequential", () => {
  assert.deepEqual(
    QUALITY_GATES.map((gate) => gate.id),
    expectedGateOrder,
  )

  const executed = []
  executeGateSequence(QUALITY_GATES, (gate) => {
    executed.push(gate.id)
    return 0
  })
  assert.deepEqual(executed, expectedGateOrder)
})

test("the first failed gate stops every later command", () => {
  const executed = []
  assert.throws(
    () =>
      executeGateSequence(QUALITY_GATES, (gate) => {
        executed.push(gate.id)
        return gate.id === "rust-clippy" ? 1 : 0
      }),
    /QUALITY_GATE_FAILED:rust-clippy/u,
  )
  assert.deepEqual(
    executed,
    expectedGateOrder.slice(0, expectedGateOrder.indexOf("rust-clippy") + 1),
  )
})

test("frontend and Rust workloads never share one gate slot", () => {
  const rustStart = QUALITY_GATES.findIndex((gate) => gate.id === "rust-format")
  const frontendEnd = QUALITY_GATES.findIndex(
    (gate) => gate.id === "live2d-inventory",
  )
  assert.equal(frontendEnd < rustStart, true)
  assert.equal(
    QUALITY_GATES.every(
      (gate) =>
        typeof gate.command === "string" &&
        Array.isArray(gate.args) &&
        gate.args.every((argument) => typeof argument === "string"),
    ),
    true,
  )
})

test("dependency-resolving Cargo gates require the committed lockfile", () => {
  for (const gateId of ["rust-clippy", "rust-test"]) {
    const gate = QUALITY_GATES.find(({ id }) => id === gateId)
    assert.ok(gate)
    assert.equal(gate.args.includes("--locked"), true)
  }
})

test("dependency licenses use the repository-owned offline check", () => {
  const gate = QUALITY_GATES.find(({ id }) => id === "dependency-licenses")
  assert.ok(gate)
  assert.deepEqual(gate.args, ["licenses:check"])
})

test("Rust integration budgets are isolated from cross-test contention", () => {
  const gate = QUALITY_GATES.find(({ id }) => id === "rust-test")
  assert.ok(gate)
  assert.deepEqual(gate.args, [
    "test",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--",
    "--test-threads=1",
  ])
})
