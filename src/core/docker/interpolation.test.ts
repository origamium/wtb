/**
 * @fileoverview interpolation.ts のユニットテスト
 */

import { describe, expect, it } from "vitest"
import { containsVariableReference, interpolateComposeValue } from "./interpolation.js"

describe("interpolateComposeValue", () => {
  // -------------------------------------------------------------------------
  // ${VAR} — シンプルな変数参照
  // -------------------------------------------------------------------------
  describe("VAR — simple reference", () => {
    it("resolves a set variable", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${APP_PORT}", { APP_PORT: "3000" })
      expect(value).toBe("3000")
      expect(unresolved).toEqual([])
    })

    it("records unresolved name and preserves text when variable is absent", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${MISSING}", {})
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      expect(value).toBe("${MISSING}")
      expect(unresolved).toContain("MISSING")
    })
  })

  // -------------------------------------------------------------------------
  // ${VAR:-default} — 未設定または空の場合デフォルト
  // -------------------------------------------------------------------------
  describe("VAR:-default (colon-dash default)", () => {
    it("uses default when variable is unset", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${DB_PORT:-54321}", {})
      expect(value).toBe("54321")
      expect(unresolved).toEqual([])
    })

    it("uses default when variable is set but empty", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${DB_PORT:-54321}", { DB_PORT: "" })
      expect(value).toBe("54321")
      expect(unresolved).toEqual([])
    })

    it("uses env value when variable is set and non-empty", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${DB_PORT:-54321}", {
        DB_PORT: "5432",
      })
      expect(value).toBe("5432")
      expect(unresolved).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // ${VAR-default} — 未設定のみデフォルト
  // -------------------------------------------------------------------------
  describe("VAR-default (dash-only default)", () => {
    it("uses default when variable is unset", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value } = interpolateComposeValue("${DB_PORT-54321}", {})
      expect(value).toBe("54321")
    })

    it("returns empty string when variable is set-but-empty", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${DB_PORT-54321}", { DB_PORT: "" })
      expect(value).toBe("")
      expect(unresolved).toEqual([])
    })

    it("returns env value when variable is set and non-empty", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value } = interpolateComposeValue("${DB_PORT-54321}", { DB_PORT: "9999" })
      expect(value).toBe("9999")
    })
  })

  // -------------------------------------------------------------------------
  // $$ — エスケープ
  // -------------------------------------------------------------------------
  describe("$$ escape", () => {
    it("replaces $$ with literal $", () => {
      const { value } = interpolateComposeValue("$$HOME", {})
      expect(value).toBe("$HOME")
    })

    it("handles multiple $$ in one string", () => {
      const { value } = interpolateComposeValue("$$A$$B", {})
      expect(value).toBe("$A$B")
    })
  })

  // -------------------------------------------------------------------------
  // $VAR — 裸の変数参照
  // -------------------------------------------------------------------------
  describe("$VAR bare reference", () => {
    it("resolves bare variable", () => {
      const { value, unresolved } = interpolateComposeValue("$APP_PORT", { APP_PORT: "8080" })
      expect(value).toBe("8080")
      expect(unresolved).toEqual([])
    })

    it("records unresolved and preserves text for missing bare variable", () => {
      const { value, unresolved } = interpolateComposeValue("$MISSING", {})
      expect(value).toBe("$MISSING")
      expect(unresolved).toContain("MISSING")
    })
  })

  // -------------------------------------------------------------------------
  // ネストしたデフォルト（既知の制限: unresolved として処理）
  // -------------------------------------------------------------------------
  describe("nested default — known limitation", () => {
    it("treats nested A:-B nested form as unresolved and preserves text", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${A:-${B}}", { B: "fallback" })
      // テキストを変更せず、変数名を unresolved に記録する
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      expect(value).toBe("${A:-${B}}")
      expect(unresolved).toContain("A")
    })
  })

  // -------------------------------------------------------------------------
  // 複数の参照を含む文字列
  // -------------------------------------------------------------------------
  describe("multiple references in one string", () => {
    it("resolves all references in a single string", () => {
      const { value, unresolved } = interpolateComposeValue(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
        "postgres://${DB_USER}:${DB_PASS}@localhost:${DB_PORT:-5432}/db",
        { DB_USER: "admin", DB_PASS: "secret", DB_PORT: "54321" }
      )
      expect(value).toBe("postgres://admin:secret@localhost:54321/db")
      expect(unresolved).toEqual([])
    })

    it("records all unresolved variables", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${A}/${B}/${C}", {})
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      expect(value).toBe("${A}/${B}/${C}")
      expect(unresolved).toContain("A")
      expect(unresolved).toContain("B")
      expect(unresolved).toContain("C")
    })

    it("mixes $$ escape and resolved references", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value } = interpolateComposeValue("$$VAR is ${VAR}", { VAR: "hello" })
      expect(value).toBe("$VAR is hello")
    })
  })
})

// =============================================================================
// M4 — VAR:?msg and VAR?msg must NOT be treated as default-value syntax
// =============================================================================

describe("M4 — required-variable syntax VAR:?msg and VAR?msg", () => {
  // ${VAR:?msg} — error if unset OR empty
  describe("VAR:?msg colon-question form", () => {
    it("treats unset variable as unresolved (preserves text, records name)", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${DB_HOST:?DB_HOST is required}", {})
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      expect(value).toBe("${DB_HOST:?DB_HOST is required}")
      expect(unresolved).toContain("DB_HOST")
    })

    it("treats empty variable as unresolved (preserves text, records name)", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${DB_HOST:?must be set}", {
        DB_HOST: "",
      })
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      expect(value).toBe("${DB_HOST:?must be set}")
      expect(unresolved).toContain("DB_HOST")
    })

    it("returns env value when variable is set and non-empty", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${DB_HOST:?must be set}", {
        DB_HOST: "localhost",
      })
      expect(value).toBe("localhost")
      expect(unresolved).toEqual([])
    })
  })

  // ${VAR?msg} — error if unset only (empty string is acceptable)
  describe("VAR?msg question-only form", () => {
    it("treats unset variable as unresolved (preserves text, records name)", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${TOKEN?TOKEN is required}", {})
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      expect(value).toBe("${TOKEN?TOKEN is required}")
      expect(unresolved).toContain("TOKEN")
    })

    it("returns env value when variable is set (even empty)", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value, unresolved } = interpolateComposeValue("${TOKEN?TOKEN is required}", {
        TOKEN: "abc",
      })
      expect(value).toBe("abc")
      expect(unresolved).toEqual([])
    })
  })

  // Confirm default-value forms still work correctly after tightening the separator
  describe("VAR:-def and VAR-def still work after M4 fix", () => {
    it("VAR:-def uses default when unset", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value } = interpolateComposeValue("${PORT:-3000}", {})
      expect(value).toBe("3000")
    })

    it("VAR:-def uses env value when set", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value } = interpolateComposeValue("${PORT:-3000}", { PORT: "8080" })
      expect(value).toBe("8080")
    })

    it("VAR-def uses default when unset", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value } = interpolateComposeValue("${PORT-3000}", {})
      expect(value).toBe("3000")
    })

    it("VAR-def returns empty string when set-but-empty", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
      const { value } = interpolateComposeValue("${PORT-3000}", { PORT: "" })
      expect(value).toBe("")
    })
  })
})

describe("containsVariableReference", () => {
  it("returns true for brace-style variable reference", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
    expect(containsVariableReference("${PORT}")).toBe(true)
  })

  it("returns true for $VAR", () => {
    expect(containsVariableReference("$PORT")).toBe(true)
  })

  it("returns false for plain string", () => {
    expect(containsVariableReference("just a string")).toBe(false)
  })

  it("returns false for $$ escape only", () => {
    // $$ is an escape — no actual variable reference
    expect(containsVariableReference("$$")).toBe(false)
  })

  it("returns true when brace-style reference appears anywhere in string", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing compose interpolation syntax
    expect(containsVariableReference("prefix-${VAR}-suffix")).toBe(true)
  })

  it("returns false for empty string", () => {
    expect(containsVariableReference("")).toBe(false)
  })
})
