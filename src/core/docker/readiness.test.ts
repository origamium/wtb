import { describe, expect, it } from "vitest"
import {
  evaluateReadiness,
  expectedComposeServices,
  parseComposePs,
  pollComposeReadiness,
} from "./readiness.js"

const web = { name: "web", replicas: 1, healthcheck: true, job: false }
const row = (state = "running", health = "healthy", extra = {}) => ({
  ID: "abc",
  Name: "app-web-1",
  Service: "web",
  State: state,
  Health: health,
  ExitCode: 0,
  ...extra,
})

describe("Compose readiness", () => {
  it("accepts array and JSONL Compose versions and rejects malformed rows", () => {
    const first = row()
    const second = row("running", "starting", { ID: "def" })
    expect(parseComposePs(JSON.stringify([first, second]))).toEqual(
      parseComposePs(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
    )
    expect(parseComposePs("")).toEqual([])
    expect(() => parseComposePs('[{"State":"running"}]')).toThrow("Service")
    expect(() => parseComposePs("not json")).toThrow()
  })

  it("requires every expected service and replica; ignores unrelated orphans", () => {
    expect(evaluateReadiness([web], [])[0].ready).toBe(false)
    const rows = parseComposePs(JSON.stringify([row(), row("exited", "", { Service: "orphan" })]))
    expect(evaluateReadiness([web], rows)[0].ready).toBe(true)
    expect(evaluateReadiness([{ ...web, replicas: 2 }], rows)[0].ready).toBe(false)
    expect(
      evaluateReadiness(
        [web],
        parseComposePs(JSON.stringify([row(), row("running", "unhealthy")]))
      )[0].ready
    ).toBe(false)
  })

  it("running without healthcheck passes, configured healthchecks must report healthy", () => {
    const rows = parseComposePs(JSON.stringify([row("running", "")]))
    expect(evaluateReadiness([{ ...web, healthcheck: false }], rows)[0].ready).toBe(true)
    expect(evaluateReadiness([web], rows)[0].ready).toBe(false)
    for (const state of ["exited", "restarting", "dead", "paused", "created"]) {
      expect(evaluateReadiness([web], parseComposePs(JSON.stringify([row(state)])))[0].ready).toBe(
        false
      )
    }
  })

  it("recognizes completed jobs, profiles, disabled healthchecks and zero replicas", () => {
    const model = JSON.stringify({
      services: {
        web: {
          depends_on: { migrate: { condition: "service_completed_successfully" } },
          healthcheck: { test: ["CMD", "true"] },
        },
        migrate: {},
        debug: { profiles: ["debug"] },
        idle: { deploy: { replicas: 0 } },
        job: { deploy: { mode: "replicated-job" } },
        nohealth: { healthcheck: { test: ["NONE"] } },
      },
    })
    const expected = expectedComposeServices(model)
    expect(expected.map((service) => service.name)).toEqual(["web", "migrate", "job", "nohealth"])
    expect(expected.find((service) => service.name === "migrate")?.job).toBe(true)
    expect(expected.find((service) => service.name === "nohealth")?.healthcheck).toBe(false)
    expect(expectedComposeServices(model, ["debug"]).map((service) => service.name)).toContain(
      "debug"
    )
    const job = { ...web, job: true }
    expect(
      evaluateReadiness([job], parseComposePs(JSON.stringify([row("exited", "")])))[0].ready
    ).toBe(true)
    expect(
      evaluateReadiness(
        [job],
        parseComposePs(JSON.stringify([row("exited", "", { ExitCode: 1 })]))
      )[0].ready
    ).toBe(false)
    expect(evaluateReadiness([job], parseComposePs(JSON.stringify([row()])))[0].ready).toBe(false)
  })

  it("polls from empty/starting to healthy without real sleeps", async () => {
    let time = 0
    const snapshots = [
      [],
      parseComposePs(JSON.stringify([row("running", "starting")])),
      parseComposePs(JSON.stringify([row()])),
    ]
    const result = await pollComposeReadiness([web], () => snapshots.shift() ?? [], 5000, {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    })
    expect(result.ok).toBe(true)
    expect(time).toBe(2000)
  })

  it("times out with last diagnostics and never treats an empty model as ready", async () => {
    let time = 0
    const result = await pollComposeReadiness([web], () => [], 1200, {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    })
    expect(result).toMatchObject({
      ok: false,
      timedOut: true,
      services: [{ service: "web", ready: false, containers: [] }],
    })
    expect(time).toBe(1200)
    await expect(pollComposeReadiness([], () => [], 2000)).rejects.toThrow("No active")
  })

  it("cannot become ready after the final read crosses the deadline", async () => {
    let time = 0
    const result = await pollComposeReadiness(
      [web],
      () => {
        time = 1001
        return parseComposePs(JSON.stringify([row()]))
      },
      1000,
      { now: () => time }
    )
    expect(result).toMatchObject({ ok: false, timedOut: true, services: [{ ready: true }] })
  })
})
