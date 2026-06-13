/**
 * @fileoverview propagate.ts のユニットテスト
 */

import { describe, expect, it } from "vitest"
import type { EnvAdjustmentChange, PortMap } from "./propagate.js"
import { buildPortMap, propagateComposeDefaults, propagatePortsInValue } from "./propagate.js"

// =============================================================================
// buildPortMap
// =============================================================================

describe("buildPortMap", () => {
  it("builds a map from valid numeric port changes", () => {
    const changes: EnvAdjustmentChange[] = [
      { key: "DB_PORT", from: "5432", to: "54321" },
      { key: "APP_PORT", from: "3000", to: "3001" },
    ]
    const map = buildPortMap(changes)
    expect(map.get(5432)).toBe(54321)
    expect(map.get(3000)).toBe(3001)
  })

  it("excludes non-numeric values", () => {
    const changes: EnvAdjustmentChange[] = [
      { key: "URL", from: "http://old", to: "http://new" },
      { key: "DB_PORT", from: "5432", to: "54321" },
    ]
    const map = buildPortMap(changes)
    expect(map.size).toBe(1)
    expect(map.get(5432)).toBe(54321)
  })

  it("excludes entries where from === to", () => {
    const changes: EnvAdjustmentChange[] = [{ key: "DB_PORT", from: "5432", to: "5432" }]
    const map = buildPortMap(changes)
    expect(map.size).toBe(0)
  })

  it("excludes out-of-range port values", () => {
    const changes: EnvAdjustmentChange[] = [
      { key: "A", from: "0", to: "5432" },
      { key: "B", from: "5432", to: "65536" },
    ]
    const map = buildPortMap(changes)
    expect(map.size).toBe(0)
  })

  it("returns empty map for empty changes", () => {
    expect(buildPortMap([])).toEqual(new Map())
  })
})

// =============================================================================
// propagatePortsInValue
// =============================================================================

describe("propagatePortsInValue", () => {
  function makeMap(pairs: [number, number][]): PortMap {
    return new Map(pairs)
  }

  it("rewrites port in a simple URL", () => {
    const { value, hits } = propagatePortsInValue(
      "http://127.0.0.1:54321",
      makeMap([[54321, 54322]])
    )
    expect(value).toBe("http://127.0.0.1:54322")
    expect(hits).toEqual([{ from: 54321, to: 54322 }])
  })

  it("rewrites port in a URL with a path suffix", () => {
    const { value } = propagatePortsInValue(
      "http://127.0.0.1:54321/auth/v1",
      makeMap([[54321, 54322]])
    )
    expect(value).toBe("http://127.0.0.1:54322/auth/v1")
  })

  it("rewrites port in a quoted value", () => {
    const { value } = propagatePortsInValue('"http://localhost:54321"', makeMap([[54321, 54322]]))
    expect(value).toBe('"http://localhost:54322"')
  })

  it("rewrites all ports in a host:port,host:port list", () => {
    const { value, hits } = propagatePortsInValue(
      "localhost:54321,localhost:54323",
      makeMap([
        [54321, 54322],
        [54323, 54324],
      ])
    )
    expect(value).toBe("localhost:54322,localhost:54324")
    expect(hits).toHaveLength(2)
  })

  it("does NOT rewrite bare numbers (no preceding colon)", () => {
    const { value, hits } = propagatePortsInValue("TIMEOUT=54321", makeMap([[54321, 54322]]))
    expect(value).toBe("TIMEOUT=54321")
    expect(hits).toHaveLength(0)
  })

  it("does NOT match 5432 inside 54321 (substring safety)", () => {
    const { value } = propagatePortsInValue("http://localhost:54321", makeMap([[5432, 9999]]))
    // 54321 should not be changed because 5432 is a substring
    expect(value).toBe("http://localhost:54321")
  })

  it("handles simultaneous map in one pass (A→B, B→C do not chain)", () => {
    // Source has :54321 and :54322 — both should be rewritten once, not chained
    const { value } = propagatePortsInValue(
      "host:54321 host:54322",
      makeMap([
        [54321, 54322],
        [54322, 54323],
      ])
    )
    // 54321 → 54322 and 54322 → 54323 in a single pass
    // The original :54321 becomes :54322 but should NOT then become :54323
    // The original :54322 becomes :54323
    expect(value).toBe("host:54322 host:54323")
  })

  it("returns unchanged value and empty hits when map is empty", () => {
    const { value, hits } = propagatePortsInValue("http://localhost:3000", new Map())
    expect(value).toBe("http://localhost:3000")
    expect(hits).toEqual([])
  })

  // M1 — URL terminator extensions: ? # @ ) ] >
  describe("M1 — propagates through additional URL terminators", () => {
    it("rewrites port before query string ? (postgres://host:5432?sslmode=require)", () => {
      const { value } = propagatePortsInValue(
        "postgres://host:5432?sslmode=require",
        makeMap([[5432, 54321]])
      )
      expect(value).toBe("postgres://host:54321?sslmode=require")
    })

    it("rewrites port before fragment # (http://h:8080#anchor)", () => {
      const { value } = propagatePortsInValue("http://h:8080#anchor", makeMap([[8080, 8081]]))
      expect(value).toBe("http://h:8081#anchor")
    })

    it("rewrites port before @ (user:3000@host pattern — unusual but valid lookahead)", () => {
      const { value } = propagatePortsInValue("pass:3000@host", makeMap([[3000, 3001]]))
      expect(value).toBe("pass:3001@host")
    })

    it("rewrites port before ) closing paren", () => {
      const { value } = propagatePortsInValue("url(http://x:3000)", makeMap([[3000, 3001]]))
      expect(value).toBe("url(http://x:3001)")
    })

    it("rewrites port before ] closing bracket", () => {
      const { value } = propagatePortsInValue("[http://x:3000]", makeMap([[3000, 3001]]))
      expect(value).toBe("[http://x:3001]")
    })

    it("rewrites port before > closing angle bracket", () => {
      const { value } = propagatePortsInValue("<http://x:3000>", makeMap([[3000, 3001]]))
      expect(value).toBe("<http://x:3001>")
    })

    it("still does NOT match 5432 inside 54321 with new terminators (boundary safety)", () => {
      // 54321 ends in a digit — the lookhead fails for 5432 (next char is '1')
      const { value } = propagatePortsInValue(
        "postgres://host:54321?sslmode=disable",
        makeMap([[5432, 9999]])
      )
      expect(value).toBe("postgres://host:54321?sslmode=disable")
    })
  })
})

// =============================================================================
// propagateComposeDefaults
// =============================================================================

describe("propagateComposeDefaults", () => {
  function makeMap(pairs: [number, number][]): PortMap {
    return new Map(pairs)
  }

  it("replaces default by VAR name match (priority 1)", () => {
    const result = propagateComposeDefaults(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
      "${DB_PORT:-5432}",
      { DB_PORT: { from: "5432", to: "54321" } },
      makeMap([[5432, 54321]])
    )
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    expect(result).toBe("${DB_PORT:-54321}")
  })

  it("replaces default by port value match (priority 2) when VAR not in envChanges", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    const result = propagateComposeDefaults("${SOME_PORT:-5432}", {}, makeMap([[5432, 54321]]))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    expect(result).toBe("${SOME_PORT:-54321}")
  })

  it("handles VAR-default (no colon) form", () => {
    const result = propagateComposeDefaults(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
      "${DB_PORT-5432}",
      { DB_PORT: { from: "5432", to: "54321" } },
      makeMap([[5432, 54321]])
    )
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    expect(result).toBe("${DB_PORT-54321}")
  })

  it("leaves unrelated defaults unchanged", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    const result = propagateComposeDefaults("${APP_ENV:-production}", {}, makeMap([[5432, 54321]]))
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    expect(result).toBe("${APP_ENV:-production}")
  })

  it("processes multiple references in a string", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    const raw = "postgres://${DB_USER:-user}:${DB_PASS:-pass}@localhost:${DB_PORT:-5432}/db"
    const result = propagateComposeDefaults(
      raw,
      { DB_PORT: { from: "5432", to: "54321" } },
      makeMap([[5432, 54321]])
    )
    expect(result).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
      "postgres://${DB_USER:-user}:${DB_PASS:-pass}@localhost:${DB_PORT:-54321}/db"
    )
  })

  it("returns raw unchanged when no envChanges and no matching ports", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    const raw = "${POSTGRES_DB:-mydb}"
    expect(propagateComposeDefaults(raw, {}, new Map())).toBe(raw)
  })

  it("priority 1 beats priority 2: uses envChanges.to even if default also matches map", () => {
    // Both rules would match, but rule 1 takes precedence
    const result = propagateComposeDefaults(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
      "${DB_PORT:-5432}",
      { DB_PORT: { from: "5432", to: "54321" } },
      makeMap([[5432, 99999]])
    )
    // Should use envChanges[DB_PORT].to = "54321", NOT map's 99999
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose variable syntax
    expect(result).toBe("${DB_PORT:-54321}")
  })
})
