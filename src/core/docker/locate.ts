/**
 * @fileoverview Docker Compose ファイルの探索ユーティリティ
 * ports.ts から切り出した resolveComposePath と fileIsReadable を提供する
 */

import { accessSync, constants as fsConstants } from "node:fs"
import * as path from "node:path"
import type { WtbConfig } from "../../types/index.js"
import { findComposeFile } from "./compose.js"

/**
 * ファイルが読み取り可能かどうかを返す
 */
export function fileIsReadable(p: string): boolean {
  try {
    accessSync(p, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * worktree に対応する Docker Compose ファイルのパスを解決する
 *
 * config.docker_compose_file が設定されている場合:
 *   1. worktreePath 基準で解決を試みる
 *   2. gitRoot 基準で解決を試みる
 *   3. どちらも読めなければ null
 *
 * 未設定の場合: worktreePath 内で compose ファイルを自動探索する
 */
export function resolveComposePath(
  worktreePath: string,
  gitRoot: string,
  config: WtbConfig
): string | null {
  if (config.docker_compose_file) {
    // docker_compose_file は config(=gitRoot)基準の相対パス。
    // worktree 内の同じ相対位置を優先、無ければ gitRoot 側を試す。
    const inWorktree = path.resolve(worktreePath, config.docker_compose_file)
    if (fileIsReadable(inWorktree)) return inWorktree
    const inRoot = path.resolve(gitRoot, config.docker_compose_file)
    if (fileIsReadable(inRoot)) return inRoot
    return null
  }
  // docker_compose_file 未設定でも worktree に compose がある場合は拾う
  return findComposeFile(worktreePath)
}
