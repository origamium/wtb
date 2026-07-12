/**
 * @fileoverview Docker Volume 操作
 * Dockerボリュームのコピー、作成、削除を担当
 * パフォーマンスを考慮したrsyncベースの実装
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import * as path from "node:path"
import { FILE_ENCODING } from "../../constants/index.js"
import type { ComposeConfig } from "../../types/index.js"
import { execDockerSafe } from "../../utils/exec.js"
import { out } from "../../utils/output.js"
import {
  acquireRepositoryLock,
  type ReleaseRepositoryLock,
} from "../git/repository.js"

/**
 * リポジトリを一意に識別する volume ラベル値 (`wtb.repo=<hash>`) を求める。
 * canonical な gitRoot パスの短いハッシュ。`wtb prune` はこの値で候補を絞り、別リポジトリの
 * wtb volume を「孤児」と誤認して消すのを防ぐ (repo スコープ)。
 */
export function repoVolumeLabel(gitRoot: string): string {
  let canonical: string
  try {
    canonical = realpathSync(gitRoot)
  } catch {
    canonical = gitRoot
  }
  return createHash("sha1").update(canonical).digest("hex").slice(0, 12)
}

/** wtb が Docker volume に付ける予約ラベル。 */
export const WTB_VOLUME_LABELS = {
  managed: "wtb.managed",
  repo: "wtb.repo",
  project: "wtb.project",
  branch: "wtb.branch",
  temp: "wtb.temp",
} as const

/** volume の所有者。repo/project/branch の 3 要素を揃えて初めて上書きを許可する。 */
export interface VolumeOwnership {
  repo: string
  project: string
  branch: string
}

/** docker volume inspect から得た wtb 所有権情報。 */
export interface VolumeOwnershipInspection {
  managed: boolean
  repo?: string
  project?: string
  branch?: string
  temp: boolean
  labels: Record<string, string>
}

/** 永続化する atomic overwrite 復旧記録。 */
export interface VolumeRecoveryRecord {
  version: 1
  /** Omitted by legacy atomic-overwrite records. */
  kind?: "atomic-overwrite" | "incomplete-fresh-copy"
  id: string
  createdAt: string
  sourceVolume: string
  targetVolume: string
  tempVolume: string
  sourceBytes: number
  stagedBytes: number
  ownership: VolumeOwnership
}

/** 復旧記録と、その実ファイルパス。 */
export interface StoredVolumeRecoveryRecord {
  path: string
  record: VolumeRecoveryRecord
}

/** common Git directory 配下に置く復旧記録ディレクトリを返す。 */
export function getVolumeRecoveryDirectory(commonGitDir: string): string {
  return path.join(commonGitDir, "wtb", "volume-recovery")
}

/**
 * A destructive copy receives only the recovery directory, so derive the common Git directory
 * from the one supported layout. Refusing arbitrary recovery paths is important: otherwise the
 * copy and `prune --yes` could lock different repositories while manipulating the same temp
 * volume/recovery record.
 */
function commonGitDirectoryFromRecoveryDirectory(recoveryDirectory: string): string {
  const resolved = path.resolve(recoveryDirectory)
  const wtbDirectory = path.dirname(resolved)
  const commonGitDir = path.dirname(wtbDirectory)
  if (
    path.basename(resolved) !== "volume-recovery" ||
    path.basename(wtbDirectory) !== "wtb" ||
    path.resolve(getVolumeRecoveryDirectory(commonGitDir)) !== resolved
  ) {
    throw new Error(
      `Volume recovery directory must be '<common-git-dir>/wtb/volume-recovery': '${recoveryDirectory}'`
    )
  }
  return commonGitDir
}

/** 所有者と temp 識別子を createVolume 用ラベルへ変換する。 */
export function buildWtbVolumeLabels(
  ownership: VolumeOwnership,
  options: { temp?: boolean } = {}
): Record<string, string> {
  return {
    [WTB_VOLUME_LABELS.repo]: ownership.repo,
    [WTB_VOLUME_LABELS.project]: ownership.project,
    [WTB_VOLUME_LABELS.branch]: ownership.branch,
    ...(options.temp === true ? { [WTB_VOLUME_LABELS.temp]: "true" } : {}),
  }
}

/** Docker volume 名の許容文字。破壊的操作の前に名前を検証する防御に使う。 */
const DOCKER_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const RECOVERY_RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/**
 * 破壊的操作 (clear / atomic overwrite の tmp 作成) の前に volume 名を検証する。
 * Docker 自身も不正名を弾くが、`/` を含む名前が万一ここへ届くと `-v /:/target` の
 * bind mount としてホストの `/` を消しかねない。防御的に早期に throw する。
 */
function assertValidVolumeName(volumeName: string): void {
  if (!DOCKER_VOLUME_NAME.test(volumeName)) {
    throw new Error(`Refusing to operate on invalid Docker volume name: '${volumeName}'`)
  }
}

/**
 * 指定 volume が wtb 作成 (`wtb.managed=true` ラベル付き) かを判定する。
 * inspect 失敗 (存在しない等) は false。破壊的な上書きの前に「wtb が所有する volume か」を
 * 確認し、無関係な既存 volume を誤って消さないためのガードに使う。
 */
export function volumeIsWtbManaged(volumeName: string): boolean {
  try {
    const label = execDockerSafe(
      ["volume", "inspect", "--format", '{{ index .Labels "wtb.managed" }}', volumeName],
      {}
    )
    return label.trim() === "true"
  } catch {
    return false
  }
}

/**
 * volume の全ラベルを strict に取得する。Docker daemon/inspect/JSON の失敗は伝播し、
 * 破壊的処理が「未管理 volume」と誤認して続行しないようにする。
 */
export function inspectVolumeOwnership(volumeName: string): VolumeOwnershipInspection {
  assertValidVolumeName(volumeName)
  const raw = execDockerSafe(
    ["volume", "inspect", "--format", "{{json .}}", volumeName],
    {}
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Cannot parse Docker inspection for volume '${volumeName}'`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Docker inspection for volume '${volumeName}'`)
  }
  const inspection = parsed as Record<string, unknown>
  if (inspection.Driver !== "local") {
    throw new Error(
      `Volume '${volumeName}' uses unsupported driver '${typeof inspection.Driver === "string" ? inspection.Driver : "unknown"}' — refusing to adopt, write, or remove it`
    )
  }
  const driverOptions = inspection.Options
  if (
    driverOptions !== null &&
    driverOptions !== undefined &&
    (typeof driverOptions !== "object" ||
      Array.isArray(driverOptions) ||
      Object.keys(driverOptions).length > 0)
  ) {
    throw new Error(
      `Volume '${volumeName}' has local driver options (for example a host bind mount) — refusing to adopt, write, or remove it`
    )
  }
  const labels: Record<string, string> = {}
  const rawLabels = inspection.Labels
  if (rawLabels !== null && typeof rawLabels === "object" && !Array.isArray(rawLabels)) {
    for (const [key, value] of Object.entries(rawLabels)) {
      if (typeof value === "string") labels[key] = value
    }
  }
  return {
    managed: labels[WTB_VOLUME_LABELS.managed] === "true",
    repo: labels[WTB_VOLUME_LABELS.repo],
    project: labels[WTB_VOLUME_LABELS.project],
    branch: labels[WTB_VOLUME_LABELS.branch],
    temp: labels[WTB_VOLUME_LABELS.temp] === "true",
    labels,
  }
}

/** 3 要素すべてが一致する wtb volume だけを同一所有者とみなす。 */
export function volumeOwnershipMatches(
  actual: VolumeOwnershipInspection,
  expected: VolumeOwnership
): boolean {
  return (
    actual.managed &&
    actual.repo === expected.repo &&
    actual.project === expected.project &&
    actual.branch === expected.branch
  )
}

/** create/idempotent create の直後に、実 volume が期待した所有者と temp 種別か再確認する。 */
export function assertVolumeOwnedBy(
  volumeName: string,
  expected: VolumeOwnership,
  options: { temp?: boolean } = {}
): VolumeOwnershipInspection {
  const actual = inspectVolumeOwnership(volumeName)
  if (
    !volumeOwnershipMatches(actual, expected) ||
    actual.temp !== (options.temp === true)
  ) {
    throw new Error(
      `Volume '${volumeName}' ownership changed before copy — refusing to write to a foreign volume`
    )
  }
  return actual
}

/**
 * ボリュームコピーの進捗情報
 */
export interface VolumeCopyProgress {
  sourceVolume: string
  targetVolume: string
  percentage: number
  bytesTransferred: number
  totalBytes: number
  speed: number
  eta: number
}

/**
 * ボリュームコピーのオプション
 */
export interface VolumeCopyOptions {
  onProgress?: (progress: VolumeCopyProgress) => void
  /** rsync `--delete` 相当を有効化(target の余剰ファイルを消す) */
  incremental?: boolean
  /** rsync `-z` 相当(cp フォールバックでは無視) */
  compress?: boolean
  /** 作成する volume に付与するリポジトリ識別ラベル値 (`wtb.repo=<value>`)。prune の repo スコープ用。 */
  repoLabel?: string
  /** repo/project/branch を揃えた所有者。新規 API では repoLabel 単体ではなくこちらを使う。 */
  ownership?: VolumeOwnership
  /** common Git directory 配下の復旧記録ディレクトリ。破壊的上書きでは必須。 */
  recoveryDirectory?: string
  /** 内部用: atomic overwrite の staging volume に temp ラベルを付ける。 */
  tempVolume?: boolean
}

type OwnedVolumeCopyOptions = VolumeCopyOptions & { ownership: VolumeOwnership }

const VOLUME_CONTENT_SIZE_COMMAND =
  'if [ -z "$(find /data -mindepth 1 -print -quit)" ]; then echo 0; else tar -C /data -cf - . | wc -c; fi'

/** copy options から createVolume 用のラベルを作る (repoLabel は後方互換)。 */
function volumeLabelArgs(options: VolumeCopyOptions): Record<string, string> {
  if (options.ownership) {
    return buildWtbVolumeLabels(options.ownership, { temp: options.tempVolume })
  }
  return {
    ...(options.repoLabel ? { [WTB_VOLUME_LABELS.repo]: options.repoLabel } : {}),
    ...(options.tempVolume === true ? { [WTB_VOLUME_LABELS.temp]: "true" } : {}),
  }
}

/**
 * ボリュームのサイズを取得する。
 *
 * @param volumeName - ボリューム名
 * @returns サイズ(バイト)。空の volume は `0`。**サイズを確定できなかった場合
 *   (docker エラー / 出力が数値でない) は `null`** を返す。`null` と `0` を区別
 *   することが重要: コピーの skip / 破壊的な上書き判定はこの値に依存するため、
 *   「プローブ失敗」を「空」と取り違えると既存データを誤って消しかねない。
 */
export function getVolumeSize(volumeName: string): number | null {
  try {
    const output = execDockerSafe(
      [
        "run",
        "--rm",
        "-v",
        `${volumeName}:/data:ro`,
        "alpine",
        "sh",
        "-c",
        VOLUME_CONTENT_SIZE_COMMAND,
      ],
      {}
    )
    const size = parseInt(output, 10)
    return Number.isNaN(size) ? null : size
  } catch {
    return null
  }
}

interface SourceVolumeLease {
  containerName: string
  containerId: string
  volumeName: string
  snapshot: string
  destination: string
  readOnly: boolean
  kind: "source" | "target"
}

interface TargetVolumeLease extends SourceVolumeLease {
  ownership: VolumeOwnership
  temp: boolean
}

/**
 * Opaque lease set used while a lifecycle command may create/mount target
 * volumes. A stopped Docker container pins each exact volume, so another wtb
 * process cannot remove and replace it between ownership validation and
 * `docker compose up` / a seed command.
 */
export interface TargetVolumeLifecycleLease {
  release(): void
}

const LEASE_KEEPALIVE_COMMAND = "while :; do sleep 3600; done"

function parseDockerObject(raw: string, description: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Cannot parse Docker inspection for ${description}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Docker inspection for ${description}`)
  }
  return parsed as Record<string, unknown>
}

/** Validate that the exact running container we created still owns the expected named-volume mount. */
function assertLeaseContainerStillValid(
  lease: SourceVolumeLease,
  options: { requireRunning: boolean } = { requireRunning: true }
): { running: boolean } {
  const inspection = parseDockerObject(
    execDockerSafe(["container", "inspect", "--format", "{{json .}}", lease.containerId], {}),
    `lease container '${lease.containerName}'`
  )
  if (inspection.Id !== lease.containerId || inspection.Name !== `/${lease.containerName}`) {
    throw new Error(
      `Lease container '${lease.containerName}' changed identity — refusing to continue`
    )
  }
  const config = inspection.Config
  const labels =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).Labels
      : undefined
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error(`Lease container '${lease.containerName}' lost its labels`)
  }
  const labelRecord = labels as Record<string, unknown>
  if (labelRecord["wtb.temp"] !== "true" || labelRecord["wtb.lease"] !== lease.kind) {
    throw new Error(`Lease container '${lease.containerName}' has unexpected ownership labels`)
  }
  const mounts = inspection.Mounts
  if (!Array.isArray(mounts) || mounts.length !== 1) {
    throw new Error(`Lease container '${lease.containerName}' has unexpected mounts`)
  }
  const mount = mounts[0]
  if (mount === null || typeof mount !== "object" || Array.isArray(mount)) {
    throw new Error(`Lease container '${lease.containerName}' has an invalid mount`)
  }
  const mountRecord = mount as Record<string, unknown>
  if (
    mountRecord.Type !== "volume" ||
    mountRecord.Name !== lease.volumeName ||
    mountRecord.Destination !== lease.destination ||
    mountRecord.RW !== !lease.readOnly
  ) {
    throw new Error(
      `Lease container '${lease.containerName}' no longer mounts exactly '${lease.volumeName}' at '${lease.destination}'`
    )
  }
  const state = inspection.State
  const running =
    state !== null &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    (state as Record<string, unknown>).Running === true
  if (options.requireRunning && !running) {
    throw new Error(
      `Lease container '${lease.containerName}' is no longer running — refusing to continue`
    )
  }
  return { running }
}

function leaseContainerId(output: string, containerName: string): string {
  const id = output.trim()
  if (!/^[a-f0-9]{12,64}$/i.test(id)) {
    throw new Error(`Docker did not return a valid id for lease container '${containerName}'`)
  }
  return id
}

/**
 * Pin a source volume with a stopped container for the duration of a copy.
 *
 * `docker run -v missing:/source` silently creates a missing named volume. A strict inspect
 * before the lease plus a byte-for-byte inspect snapshot after container creation catches a
 * remove/recreate race; once the lease exists Docker refuses to remove the source volume.
 */
function acquireSourceVolumeLease(sourceVolume: string): SourceVolumeLease {
  assertValidVolumeName(sourceVolume)
  const before = execDockerSafe(["volume", "inspect", sourceVolume], {})
  const sourceHash = createHash("sha1").update(sourceVolume).digest("hex").slice(0, 12)
  const containerName = `wtb-volume-lease-${sourceHash}-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
  let lease: SourceVolumeLease | undefined
  try {
    const containerId = leaseContainerId(
      execDockerSafe(
        [
          "run",
          "--detach",
          "--name",
          containerName,
          "--label",
          "wtb.temp=true",
          "--label",
          "wtb.lease=source",
          "--mount",
          `type=volume,src=${sourceVolume},dst=/wtb-source,readonly`,
          "alpine",
          "sh",
          "-c",
          LEASE_KEEPALIVE_COMMAND,
        ],
        {}
      ),
      containerName
    )
    lease = {
      containerName,
      containerId,
      volumeName: sourceVolume,
      snapshot: before,
      destination: "/wtb-source",
      readOnly: true,
      kind: "source",
    }
    const after = execDockerSafe(["volume", "inspect", sourceVolume], {})
    if (after !== before) {
      throw new Error(
        `Source volume '${sourceVolume}' changed while acquiring a copy lease — refusing to copy`
      )
    }
    lease.snapshot = after
    assertLeaseContainerStillValid(lease)
    return lease
  } catch (error) {
    if (lease) {
      try {
        execDockerSafe(["rm", "-f", lease.containerId], {})
      } catch {
        // Preserve the acquisition error; the leftover lease is safe and keeps data pinned.
      }
    }
    throw error
  }
}

function releaseVolumeLease(lease: SourceVolumeLease): void {
  execDockerSafe(["rm", "-f", lease.containerId], {})
}

function targetLeaseContainerName(targetVolume: string): string {
  const hash = createHash("sha1").update(targetVolume).digest("hex").slice(0, 12)
  // Deterministic per target: `docker create --name` is the operation lock. A concurrent copy or
  // stale lease therefore blocks safely with a name collision; stale target leases are never
  // auto-removed because they may be the only thing still pinning data after an interrupted copy.
  return `wtb-target-lease-${hash}`
}

function findExactContainerByName(
  containerName: string
): { id: string; name: string } | undefined {
  const output = execDockerSafe(
    [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `name=^${containerName}$`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ],
    {}
  )
  const matches = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id = "", name = ""] = line.split("\t")
      return { id: id.trim(), name: name.trim() }
    })
    .filter(({ name }) => name === containerName)
  if (matches.length === 0) return undefined
  if (matches.length !== 1) {
    throw new Error(`Multiple containers claim deterministic name '${containerName}'`)
  }
  return matches[0]
}

function assertNoUnresolvedTargetVolumeLease(targetVolume: string): void {
  const containerName = targetLeaseContainerName(targetVolume)
  const existing = findExactContainerByName(containerName)
  if (!existing) return
  const lease: SourceVolumeLease = {
    containerName,
    containerId: leaseContainerId(existing.id, containerName),
    volumeName: targetVolume,
    snapshot: "",
    destination: "/wtb-target",
    readOnly: false,
    kind: "target",
  }
  const { running } = assertLeaseContainerStillValid(lease, { requireRunning: false })
  throw new Error(
    `Unresolved ${running ? "running" : "stopped"} target volume lease '${containerName}' is still pinning '${targetVolume}'. Inspect it and remove it manually only after confirming that no interrupted copy or recovery is pending`
  )
}

export interface VolumeCloneOperationLock {
  /** Deterministic name, exposed only for diagnostics and manual recovery instructions. */
  containerName: string
  release(): void
}

function assertCloneOperationLockContainer(
  containerId: string,
  containerName: string,
  repo: string,
  sourceProject: string,
  options: { requireRunning: boolean }
): { running: boolean } {
  const inspection = parseDockerObject(
    execDockerSafe(["container", "inspect", "--format", "{{json .}}", containerId], {}),
    `clone-operation lock '${containerName}'`
  )
  if (inspection.Id !== containerId || inspection.Name !== `/${containerName}`) {
    throw new Error(`Clone-operation lock '${containerName}' changed identity`)
  }
  const config = inspection.Config
  const labels =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).Labels
      : undefined
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error(`Clone-operation lock '${containerName}' lost its labels`)
  }
  const labelRecord = labels as Record<string, unknown>
  if (
    labelRecord["wtb.temp"] !== "true" ||
    labelRecord["wtb.lock"] !== "volume-clone" ||
    labelRecord[WTB_VOLUME_LABELS.repo] !== repo ||
    labelRecord["wtb.source-project"] !== sourceProject
  ) {
    throw new Error(`Clone-operation lock '${containerName}' has unexpected ownership labels`)
  }
  if (!Array.isArray(inspection.Mounts) || inspection.Mounts.length !== 0) {
    throw new Error(`Clone-operation lock '${containerName}' has unexpected mounts`)
  }
  const state = inspection.State
  const running =
    state !== null &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    (state as Record<string, unknown>).Running === true
  if (options.requireRunning && !running) {
    throw new Error(`Clone-operation lock '${containerName}' is no longer running`)
  }
  return { running }
}

/**
 * Serialize the full source-stack clone lifecycle for one repository + source Compose project.
 * The deterministic running container survives `docker container prune`. Any stale lock is left
 * untouched and requires explicit operator inspection/removal so an interrupted source restart
 * cannot be silently overlapped by a later clone.
 */
export function acquireVolumeCloneOperationLock(
  repo: string,
  sourceProject: string
): VolumeCloneOperationLock {
  if (!repo || !sourceProject || repo.includes("\0") || sourceProject.includes("\0")) {
    throw new Error("Volume clone operation lock requires non-empty repo and source project keys")
  }
  const hash = createHash("sha256")
    .update(repo)
    .update("\0")
    .update(sourceProject)
    .digest("hex")
    .slice(0, 24)
  const containerName = `wtb-volume-clone-lock-${hash}`
  const existing = findExactContainerByName(containerName)
  if (existing) {
    let state: { running: boolean }
    try {
      const id = leaseContainerId(existing.id, containerName)
      state = assertCloneOperationLockContainer(id, containerName, repo, sourceProject, {
        requireRunning: false,
      })
    } catch (error) {
      throw new Error(
        `Deterministic clone-operation lock '${containerName}' already exists but cannot be validated. Do not remove it until any interrupted volume copy/source restart has been investigated: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    throw new Error(
      `Unresolved ${state.running ? "running" : "stopped"} clone-operation lock '${containerName}' already exists for repository '${repo}' and source project '${sourceProject}'. Inspect it and remove it manually only after confirming that no interrupted copy or source restart is pending`
    )
  }

  let containerId: string
  try {
    containerId = leaseContainerId(
      execDockerSafe(
        [
          "run",
          "--detach",
          "--name",
          containerName,
          "--label",
          "wtb.temp=true",
          "--label",
          "wtb.lock=volume-clone",
          "--label",
          `${WTB_VOLUME_LABELS.repo}=${repo}`,
          "--label",
          `wtb.source-project=${sourceProject}`,
          "alpine",
          "sh",
          "-c",
          LEASE_KEEPALIVE_COMMAND,
        ],
        {}
      ),
      containerName
    )
    assertCloneOperationLockContainer(containerId, containerName, repo, sourceProject, {
      requireRunning: true,
    })
  } catch (error) {
    throw new Error(
      `Could not acquire clone-operation lock '${containerName}'. Another clone may be running, or a stale lock from an interrupted clone/source restart needs manual recovery. Docker error: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  let released = false
  return {
    containerName,
    release(): void {
      if (released) return
      assertCloneOperationLockContainer(containerId, containerName, repo, sourceProject, {
        requireRunning: true,
      })
      execDockerSafe(["rm", "-f", containerId], {})
      released = true
    },
  }
}

function assertTargetOwnership(
  targetVolume: string,
  ownership: VolumeOwnership,
  temp: boolean
): void {
  const actual = inspectVolumeOwnership(targetVolume)
  if (!volumeOwnershipMatches(actual, ownership) || actual.temp !== temp) {
    const owner = `${actual.repo ?? "?"}/${actual.project ?? "?"}/${actual.branch ?? "?"}`
    throw new Error(
      `Target volume '${targetVolume}' ownership changed (${owner}, temp=${actual.temp}) — refusing to copy`
    )
  }
}

/**
 * Pin the already-created, correctly-owned target with a stopped container. Docker refuses to
 * remove a volume referenced by any container, so the name cannot be removed/recreated between
 * ownership validation and the actual rsync/cp/atomic commit.
 */
function acquireTargetVolumeLease(
  targetVolume: string,
  ownership: VolumeOwnership,
  options: { temp: boolean }
): TargetVolumeLease {
  assertValidVolumeName(targetVolume)
  const before = execDockerSafe(["volume", "inspect", targetVolume], {})
  assertTargetOwnership(targetVolume, ownership, options.temp)
  const containerName = targetLeaseContainerName(targetVolume)
  let lease: TargetVolumeLease | undefined
  try {
    const containerId = leaseContainerId(
      execDockerSafe(
        [
          "run",
          "--detach",
          "--name",
          containerName,
          "--label",
          "wtb.temp=true",
          "--label",
          "wtb.lease=target",
          "--mount",
          `type=volume,src=${targetVolume},dst=/wtb-target`,
          "alpine",
          "sh",
          "-c",
          LEASE_KEEPALIVE_COMMAND,
        ],
        {}
      ),
      containerName
    )
    lease = {
      containerName,
      containerId,
      volumeName: targetVolume,
      snapshot: before,
      destination: "/wtb-target",
      readOnly: false,
      kind: "target",
      ownership,
      temp: options.temp,
    }
    const after = execDockerSafe(["volume", "inspect", targetVolume], {})
    assertTargetOwnership(targetVolume, ownership, options.temp)
    if (after !== before) {
      throw new Error(
        `Target volume '${targetVolume}' changed while acquiring a copy lease — refusing to copy`
      )
    }
    lease.snapshot = after
    assertTargetLeaseStillValid(lease)
    return lease
  } catch (error) {
    if (lease) {
      try {
        releaseVolumeLease(lease)
      } catch {
        // Preserve the acquisition error. A leftover stopped lease safely pins the volume.
      }
    } else {
      throw new Error(
        `Could not acquire target volume lease '${containerName}'. Another copy may be running, or a stale lease from an interrupted copy is still pinning '${targetVolume}'. Inspect that container and remove it manually only after confirming no recovery is needed. Docker error: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    throw error
  }
}

/**
 * Strictly prepare and pin every non-external target volume for a lifecycle
 * operation. Missing (or safely removed empty-unmanaged) volumes are created
 * with the complete ownership label set before their deterministic leases are
 * acquired. If any volume cannot be proven safe, all leases already acquired
 * by this call are released and the operation fails closed.
 */
export function acquireTargetVolumeLifecycleLeases(
  targetVolumes: string[],
  ownership: VolumeOwnership,
  options: { requireEmpty?: boolean } = {}
): TargetVolumeLifecycleLease {
  const leases: TargetVolumeLease[] = []
  const uniqueTargets = [...new Set(targetVolumes)]
  try {
    for (const targetVolume of uniqueTargets) {
      assertNoUnresolvedTargetVolumeLease(targetVolume)
      const runningHolders = getContainersUsingVolumeWithProjectOrThrow(targetVolume)
      if (runningHolders.length > 0) {
        const foreignHolders = runningHolders.filter(
          (holder) => holder.project !== ownership.project
        )
        if (foreignHolders.length > 0) {
          throw new Error(
            `Target volume '${targetVolume}' is in use outside Compose project '${ownership.project}' by ${foreignHolders.map((holder) => holder.name).join(", ")}`
          )
        }
        if (options.requireEmpty === true) {
          throw new Error(
            `Target volume '${targetVolume}' is already mounted by Compose project '${ownership.project}'; seed_command requires an exclusively leased fresh empty target`
          )
        }
        // Same-project running containers already pin this exact name. Validate the volume's
        // backend and ownership, but do not create a competing lease container.
        assertTargetOwnership(targetVolume, ownership, false)
        continue
      }
      const preflight = preflightTargetVolumeForCopy(targetVolume, ownership)
      if (options.requireEmpty === true && preflight.size > 0) {
        throw new Error(
          `Target volume '${targetVolume}' already contains data; seed_command requires a fresh empty target`
        )
      }
      createVolume(targetVolume, "local", buildWtbVolumeLabels(ownership))
      const lease = acquireTargetVolumeLease(targetVolume, ownership, { temp: false })
      if (options.requireEmpty === true) {
        // The running lease now prevents remove/recreate and concurrent non-Compose mounting.
        // Re-probe after acquisition so a writer between initial preflight and the lease cannot
        // smuggle data into a seed target.
        const leasedSize = getVolumeSize(targetVolume)
        if (leasedSize === null || leasedSize !== 0) {
          try {
            releaseVolumeLease(lease)
          } catch {
            // A surviving running lease remains a safe fail-closed pin.
          }
          throw new Error(
            leasedSize === null
              ? `Cannot verify that leased target volume '${targetVolume}' is empty for seed_command`
              : `Target volume '${targetVolume}' gained data before its seed lease was acquired`
          )
        }
      }
      leases.push(lease)
    }
  } catch (error) {
    const cleanupErrors: unknown[] = []
    for (const lease of leases.reverse()) {
      try {
        releaseVolumeLease(lease)
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Could not safely acquire target volume lifecycle leases and failed to release ${cleanupErrors.length} partial lease(s)`
      )
    }
    throw error
  }

  let released = false
  return {
    release(): void {
      if (released) return
      const errors: unknown[] = []
      for (const lease of [...leases].reverse()) {
        try {
          releaseVolumeLease(lease)
        } catch (error) {
          errors.push(error)
        }
      }
      released = true
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(errors, `Failed to release ${errors.length} target volume leases`)
      }
    },
  }
}

function assertTargetLeaseStillValid(lease: TargetVolumeLease): void {
  assertLeaseContainerStillValid(lease)
  const current = execDockerSafe(["volume", "inspect", lease.volumeName], {})
  if (current !== lease.snapshot) {
    throw new Error(
      `Target volume '${lease.volumeName}' changed after its copy lease was acquired — refusing to write`
    )
  }
  assertTargetOwnership(lease.volumeName, lease.ownership, lease.temp)
  const activeHolders = getRunningVolumeHoldersOrThrow(lease.volumeName).filter(
    (holder) => holder.id !== lease.containerId
  )
  if (activeHolders.length > 0) {
    throw new Error(
      `Target volume '${lease.volumeName}' is in use by ${activeHolders.map((holder) => holder.name).join(", ")} while its copy lease is held`
    )
  }
}

/**
 * ボリュームを作成
 *
 * @param volumeName - 作成するボリューム名
 * @param driver - ドライバー（デフォルト: local）
 */
export function createVolume(
  volumeName: string,
  driver: string = "local",
  extraLabels: Record<string, string> = {}
): void {
  assertValidVolumeName(volumeName)
  // wtb が作成した volume には `wtb.managed=true` ラベルを付け、自己識別できるようにする。
  // これで `wtb status` はディレクトリ名の命名規則に依存せず (カスタム -p パスでも)
  // wtb 管理 volume を正確に列挙でき、ユーザ/agent も
  // `docker volume ls --filter label=wtb.managed=true` で発見・整理できる。
  // extraLabels には作成元リポジトリを示す `wtb.repo=<hash>` を渡し、`wtb prune` が
  // 別リポジトリの現役 volume を「孤児」と誤認して消すのを防ぐ (repo スコープ)。
  const labelArgs: string[] = ["--label", "wtb.managed=true"]
  for (const [k, v] of Object.entries(extraLabels)) {
    labelArgs.push("--label", `${k}=${v}`)
  }
  execDockerSafe(["volume", "create", "--driver", driver, ...labelArgs, volumeName], {})
}

/**
 * volume を削除する (best-effort)。
 *
 * atomic overwrite の一時 volume の後始末に使う。存在しない / 使用中などで失敗
 * しても例外は投げない (元のエラーを隠さないため)。
 */
export function removeVolume(volumeName: string): void {
  try {
    const inspection = inspectVolumeOwnership(volumeName)
    if (!inspection.managed || !inspection.temp) {
      return
    }
    execDockerSafe(["volume", "rm", "-f", volumeName], {})
  } catch {
    // best-effort cleanup; 失敗しても呼び出し側の処理は続行する
  }
}

/** volume を削除し、Docker エラーを握り潰さない破壊的処理向け API。 */
export function removeVolumeOrThrow(volumeName: string): void {
  assertValidVolumeName(volumeName)
  // Revalidate the backend immediately before deletion. Callers may intentionally remove an
  // empty unmanaged target, so ownership is not required here, but bind-backed/non-local storage
  // must never reach `docker volume rm`.
  inspectVolumeOwnership(volumeName)
  execDockerSafe(["volume", "rm", "-f", volumeName], {})
}

/**
 * volume の存在を strict に調べる。inspect の「存在しない」と「daemon down」を同一視
 * しないよう、volume ls 自体の成否を確認したうえで完全一致する名前を探す。
 */
export function volumeExistsOrThrow(volumeName: string): boolean {
  assertValidVolumeName(volumeName)
  const output = execDockerSafe(
    ["volume", "ls", "--quiet", "--filter", `name=^${volumeName}$`],
    {}
  )
  return output
    .split("\n")
    .map((entry) => entry.trim())
    .some((entry) => entry === volumeName)
}

/** strict な volume 使用中コンテナ列挙。prune/再作成の安全判定で使う。 */
export function getContainersUsingVolumeOrThrow(volumeName: string): string[] {
  return getRunningVolumeHoldersOrThrow(volumeName).map((holder) => holder.name)
}

interface RunningVolumeHolder {
  id: string
  name: string
}

function getRunningVolumeHoldersOrThrow(volumeName: string): RunningVolumeHolder[] {
  assertValidVolumeName(volumeName)
  const output = execDockerSafe(
    [
      "ps",
      "--no-trunc",
      "--filter",
      `volume=${volumeName}`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ],
    {}
  )
  if (!output) return []
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tabIndex = line.indexOf("\t")
      if (tabIndex < 0) return { id: line, name: line }
      return {
        id: line.slice(0, tabIndex).trim(),
        name: line.slice(tabIndex + 1).trim(),
      }
    })
    .filter((entry) => entry.id.length > 0 && entry.name.length > 0)
}

/**
 * volume の中身を全削除する (`find /target -mindepth 1 -delete` 相当)。
 *
 * `cp -a /source/. /target/` 単体では target の余剰ファイルが残るため、上書き
 * セマンティクスを保つコピー前のクリアに使う。copyVolumeWithCp と atomic
 * overwrite の commit 段階で共有する。
 */
function clearVolume(volumeName: string): void {
  assertValidVolumeName(volumeName)
  execDockerSafe(
    [
      "run",
      "--rm",
      "-v",
      `${volumeName}:/target`,
      "alpine",
      "sh",
      "-c",
      "find /target -mindepth 1 -delete",
    ],
    {}
  )
}

/**
 * atomic overwrite 用の一時 volume 名を生成する。
 * pid + 時刻 + 乱数で衝突を実質回避する (並行 create / リトライ対策)。
 * Docker volume 名の許容文字 [a-zA-Z0-9_.-] のみを使う。
 */
function makeTempVolumeName(targetVolume: string): string {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return `${targetVolume}__wtbtmp_${suffix}`
}

function makeRecoveryId(): string {
  return `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 10)}`
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** JSON を同一 directory 内で write+fsync+rename し、復旧記録を原子的に公開する。 */
export function writeVolumeRecoveryRecord(
  recoveryDirectory: string,
  record: VolumeRecoveryRecord
): StoredVolumeRecoveryRecord {
  if (!RECOVERY_RECORD_ID.test(record.id)) {
    throw new Error(`Invalid volume recovery record id '${record.id}'`)
  }
  mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 })
  const finalPath = path.join(recoveryDirectory, `${record.id}.json`)
  const tempPath = path.join(recoveryDirectory, `.${record.id}.${process.pid}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tempPath, "wx", 0o600)
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, finalPath)
    fsyncDirectory(recoveryDirectory)
    return { path: finalPath, record }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(tempPath)
    } catch {
      // temp が未作成/rename 済みなら何もしない
    }
    throw error
  }
}

function isVolumeOwnership(value: unknown): value is VolumeOwnership {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<VolumeOwnership>
  return (
    typeof candidate.repo === "string" &&
    candidate.repo.length > 0 &&
    typeof candidate.project === "string" &&
    candidate.project.length > 0 &&
    typeof candidate.branch === "string" &&
    candidate.branch.length > 0
  )
}

function isVolumeRecoveryRecord(value: unknown): value is VolumeRecoveryRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Partial<VolumeRecoveryRecord>
  return (
    record.version === 1 &&
    (record.kind === undefined ||
      record.kind === "atomic-overwrite" ||
      record.kind === "incomplete-fresh-copy") &&
    typeof record.id === "string" &&
    RECOVERY_RECORD_ID.test(record.id) &&
    typeof record.createdAt === "string" &&
    typeof record.sourceVolume === "string" &&
    DOCKER_VOLUME_NAME.test(record.sourceVolume) &&
    typeof record.targetVolume === "string" &&
    DOCKER_VOLUME_NAME.test(record.targetVolume) &&
    typeof record.tempVolume === "string" &&
    DOCKER_VOLUME_NAME.test(record.tempVolume) &&
    typeof record.sourceBytes === "number" &&
    Number.isSafeInteger(record.sourceBytes) &&
    record.sourceBytes >= 0 &&
    typeof record.stagedBytes === "number" &&
    Number.isSafeInteger(record.stagedBytes) &&
    record.stagedBytes >= 0 &&
    isVolumeOwnership(record.ownership)
  )
}

/**
 * 復旧記録を読み込む。1 件でも破損していれば例外にし、prune が保護対象を見落として
 * temp volume を削除することを防ぐ (fail-closed)。
 */
export function readVolumeRecoveryRecords(
  recoveryDirectory: string
): StoredVolumeRecoveryRecord[] {
  if (!existsSync(recoveryDirectory)) return []
  const records: StoredVolumeRecoveryRecord[] = []
  for (const fileName of readdirSync(recoveryDirectory)) {
    if (!fileName.endsWith(".json")) continue
    const recordPath = path.join(recoveryDirectory, fileName)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(recordPath, "utf8"))
    } catch (error) {
      throw new Error(
        `Cannot read volume recovery record '${recordPath}': ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!isVolumeRecoveryRecord(parsed) || fileName !== `${parsed.id}.json`) {
      throw new Error(`Invalid volume recovery record '${recordPath}'`)
    }
    records.push({ path: recordPath, record: parsed })
  }
  return records
}

/** 復旧記録を削除し、directory entry まで fsync する。 */
export function removeVolumeRecoveryRecord(recordPath: string): void {
  const directory = path.dirname(recordPath)
  unlinkSync(recordPath)
  fsyncDirectory(directory)
}

/** rsync の速度単位 → bytes/sec 倍率。未知の単位は「不明」(0) として扱い、勝手に bytes と誤認しない。 */
const RSYNC_SPEED_UNITS: Record<string, number> = {
  "b/s": 1,
  "kb/s": 1024,
  "mb/s": 1024 * 1024,
  "gb/s": 1024 * 1024 * 1024,
  "tb/s": 1024 * 1024 * 1024 * 1024,
}

/**
 * rsync `--info=progress2` の 1 行から進捗を抽出する純粋関数。
 *
 * 例: `  1,234,567  45%   12.34MB/s    0:00:12`
 * - ETA (`H:M:S`) は rsync のビルド差で欠ける場合があるため任意とし、無ければ `eta=0`。
 * - 速度単位が未知 (上記マップ外) のときは `speed=0` を返す。0 を「不明」として
 *   扱い、未知単位を bytes と誤って巨大な速度に化けさせない。
 *
 * @returns 進捗。行が進捗フォーマットでなければ `null`。
 */
export function parseRsyncProgress(
  line: string
): { bytesTransferred: number; percentage: number; speed: number; eta: number } | null {
  const m = line.match(/(\d[\d,]*)\s+(\d+)%\s+([\d.]+)([A-Za-z]+\/s)(?:\s+(\d+):(\d+):(\d+))?/)
  if (!m) return null

  const bytesTransferred = parseInt(m[1].replace(/,/g, ""), 10)
  const percentage = parseInt(m[2], 10)
  const value = parseFloat(m[3])
  const unit = m[4].toLowerCase()
  const multiplier = RSYNC_SPEED_UNITS[unit]
  const speed = multiplier !== undefined ? value * multiplier : 0

  let eta = 0
  if (m[5] !== undefined) {
    eta = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7])
  }

  return { bytesTransferred, percentage, speed, eta }
}

/**
 * rsyncを使用した高速ボリュームコピー
 *
 * @param sourceVolume - コピー元ボリューム名
 * @param targetVolume - コピー先ボリューム名
 * @param options - コピーオプション
 * @returns コピー結果のPromise
 */
async function copyVolumeWithRsync(
  sourceVolume: string,
  targetVolume: string,
  options: OwnedVolumeCopyOptions,
  targetLease: TargetVolumeLease
): Promise<void> {
  if (!options?.ownership) {
    throw new Error("Volume copy requires repo/project/branch ownership metadata")
  }
  const { onProgress, incremental = true, compress = false } = options

  assertTargetLeaseStillValid(targetLease)

  const totalBytes = getVolumeSize(sourceVolume) ?? 0

  const rsyncFlags = ["-a", "--info=progress2", "--no-inc-recursive"]

  if (incremental) {
    rsyncFlags.push("--delete")
  }

  if (compress) {
    rsyncFlags.push("-z")
  }

  const rsyncCommand = `rsync ${rsyncFlags.join(" ")} /source/ /target/`

  return new Promise((resolve, reject) => {
    const dockerProcess = spawn("docker", [
      "run",
      "--rm",
      "-v",
      `${sourceVolume}:/source:ro`,
      "-v",
      `${targetVolume}:/target`,
      "instrumentisto/rsync-ssh",
      "sh",
      "-c",
      rsyncCommand,
    ])

    let lastProgress: VolumeCopyProgress = {
      sourceVolume,
      targetVolume,
      percentage: 0,
      bytesTransferred: 0,
      totalBytes,
      speed: 0,
      eta: 0,
    }

    dockerProcess.stdout.on("data", (data: Buffer) => {
      const output = data.toString()

      const progress = parseRsyncProgress(output)

      if (progress && onProgress) {
        lastProgress = {
          sourceVolume,
          targetVolume,
          percentage: progress.percentage,
          bytesTransferred: progress.bytesTransferred,
          totalBytes,
          speed: progress.speed,
          eta: progress.eta,
        }

        onProgress(lastProgress)
      }
    })

    // rsync の stderr は全量バッファする。失敗時に診断できるよう、
    // close ハンドラで例外メッセージへ畳み込む (末尾を切り詰めて肥大化を防ぐ)。
    let stderrBuffer = ""
    dockerProcess.stderr.on("data", (data: Buffer) => {
      stderrBuffer += data.toString()
      if (stderrBuffer.length > 8192) {
        stderrBuffer = stderrBuffer.slice(-8192)
      }
    })

    dockerProcess.on("close", (code) => {
      if (code === 0) {
        if (onProgress) {
          onProgress({
            ...lastProgress,
            percentage: 100,
            bytesTransferred: totalBytes,
          })
        }
        resolve()
      } else {
        const detail = stderrBuffer.trim()
        reject(new Error(`Volume copy failed with exit code ${code}${detail ? `: ${detail}` : ""}`))
      }
    })

    dockerProcess.on("error", (error) => {
      reject(error)
    })
  })
}

/**
 * cpコマンドを使用したボリュームコピー（フォールバック用）
 *
 * @param sourceVolume - コピー元ボリューム名
 * @param targetVolume - コピー先ボリューム名
 * @param options - コピー設定 (onProgress, clearTarget)
 *
 * `clearTarget: true` を指定すると、コピー前に target volume の中身を全削除する
 * (rsync の `--delete` 相当)。`--force-volume-copy` 経由で呼ばれた際の上書き
 * セマンティクスを保つために必要。デフォルトは false (既存ファイル保持) で、
 * これは rsync の非 incremental 動作と等価。
 */
async function copyVolumeWithCp(
  sourceVolume: string,
  targetVolume: string,
  options: OwnedVolumeCopyOptions & { clearTarget?: boolean },
  targetLease: TargetVolumeLease
): Promise<void> {
  if (!options?.ownership) {
    throw new Error("Volume copy requires repo/project/branch ownership metadata")
  }
  const { onProgress, clearTarget = false } = options
  assertTargetLeaseStillValid(targetLease)

  const totalBytes = getVolumeSize(sourceVolume) ?? 0

  if (onProgress) {
    onProgress({
      sourceVolume,
      targetVolume,
      percentage: 0,
      bytesTransferred: 0,
      totalBytes,
      speed: 0,
      eta: 0,
    })
  }

  // force 時は target の既存ファイルを先に消す。
  // `cp -a /source/. /target/` 単体では target の余分なファイルが残るため。
  if (clearTarget) {
    clearVolume(targetVolume)
  }

  execDockerSafe(
    [
      "run",
      "--rm",
      "-v",
      `${sourceVolume}:/source:ro`,
      "-v",
      `${targetVolume}:/target`,
      "alpine",
      "sh",
      "-c",
      "cp -a /source/. /target/",
    ],
    {}
  )

  if (onProgress) {
    onProgress({
      sourceVolume,
      targetVolume,
      percentage: 100,
      bytesTransferred: totalBytes,
      totalBytes,
      speed: 0,
      eta: 0,
    })
  }
}

export type TargetVolumePreparationState = "missing" | "owned" | "recreated-empty"

export interface TargetVolumePreflight {
  state: TargetVolumePreparationState
  /** Strictly measured bytes. Missing/recreated-empty targets report zero. */
  size: number
}

/**
 * Inspect and, only for an empty unused unmanaged target, prepare a destination before planning.
 * This deliberately does not authorize overwriting an owned volume with data; callers use the
 * returned size to classify it as skip/overwrite. `prepareTargetVolumeForCopy` applies that final
 * authorization immediately before I/O as a TOCTOU safety net.
 */
export function preflightTargetVolumeForCopy(
  targetVolume: string,
  ownership: VolumeOwnership
): TargetVolumePreflight {
  assertNoUnresolvedTargetVolumeLease(targetVolume)
  if (!volumeExistsOrThrow(targetVolume)) return { state: "missing", size: 0 }

  const activeHolders = getContainersUsingVolumeOrThrow(targetVolume)
  if (activeHolders.length > 0) {
    throw new Error(
      `Target volume '${targetVolume}' is in use by ${activeHolders.join(", ")} — refusing to copy into a live target`
    )
  }

  // Validate the storage backend before mounting it for a size probe. A local volume with
  // driver_opts can be a host bind mount, and a non-local driver can have arbitrary destructive
  // semantics; neither may be adopted, written, or removed by wtb even when labels match.
  const actual = inspectVolumeOwnership(targetVolume)
  const size = getVolumeSize(targetVolume)
  if (size === null) {
    throw new Error(
      `Cannot determine size of existing target volume '${targetVolume}' — refusing to overwrite`
    )
  }

  if (!actual.managed) {
    if (size > 0) {
      throw new Error(
        `Target volume '${targetVolume}' has data but is not wtb-managed — refusing to overwrite even with force`
      )
    }
    removeVolumeOrThrow(targetVolume)
    if (volumeExistsOrThrow(targetVolume)) {
      throw new Error(`Could not remove empty unmanaged target volume '${targetVolume}'`)
    }
    return { state: "recreated-empty", size: 0 }
  }

  if (actual.temp || !volumeOwnershipMatches(actual, ownership)) {
    const owner = `${actual.repo ?? "?"}/${actual.project ?? "?"}/${actual.branch ?? "?"}`
    throw new Error(
      `Target volume '${targetVolume}' is owned by another wtb target (${owner}) — refusing to overwrite`
    )
  }

  return { state: "owned", size }
}

/**
 * 所有者情報付きコピーの直前に既存 target を再検査する (TOCTOU safety net)。
 *
 * - データ入りの unmanaged/foreign volume は force 相当の clearTarget でも拒否
 * - 空の unmanaged volume だけは、未使用を strict に確認して削除し、後続 create で
 *   正しいラベル付き volume として作り直す
 * - managed volume は repo/project/branch の完全一致を必須にする
 */
export function prepareTargetVolumeForCopy(
  targetVolume: string,
  ownership: VolumeOwnership,
  options: { allowOverwrite: boolean }
): TargetVolumePreparationState {
  const preflight = preflightTargetVolumeForCopy(targetVolume, ownership)
  if (preflight.size > 0 && !options.allowOverwrite) {
    throw new Error(
      `Target volume '${targetVolume}' already contains data — explicit overwrite was not authorized`
    )
  }
  return preflight.state
}

async function persistIncompleteFreshCopyRecord(
  sourceVolume: string,
  targetVolume: string,
  ownership: VolumeOwnership,
  recoveryDirectory: string | undefined,
  stagedBytes: number
): Promise<StoredVolumeRecoveryRecord> {
  if (!recoveryDirectory) {
    throw new Error(
      `Cannot persist incomplete-copy recovery marker for '${targetVolume}' because no recoveryDirectory was provided`
    )
  }
  const commonGitDir = commonGitDirectoryFromRecoveryDirectory(recoveryDirectory)
  const releaseRepositoryLock = await acquireRepositoryLock(commonGitDir)
  try {
    const id = makeRecoveryId()
    const markerVolume = `${targetVolume}__wtbincomplete_${id}`
    createVolume(markerVolume, "local", buildWtbVolumeLabels(ownership, { temp: true }))
    assertVolumeOwnedBy(markerVolume, ownership, { temp: true })
    const record: VolumeRecoveryRecord = {
      version: 1,
      kind: "incomplete-fresh-copy",
      id,
      createdAt: new Date().toISOString(),
      sourceVolume,
      targetVolume,
      // A separate empty temp marker lets `prune --yes --discard-recovery` discard the record
      // using its existing exact temp-ownership guard. The partial target itself remains pinned
      // by the running deterministic lease until an operator resolves it.
      tempVolume: markerVolume,
      sourceBytes: getVolumeSize(sourceVolume) ?? 0,
      stagedBytes,
      ownership,
    }
    const expectedPath = path.join(recoveryDirectory, `${id}.json`)
    try {
      return writeVolumeRecoveryRecord(recoveryDirectory, record)
    } catch (error) {
      if (!existsSync(expectedPath)) removeVolume(markerVolume)
      throw error
    }
  } finally {
    await releaseRepositoryLock()
  }
}

/**
 * 最適な方法でボリュームをコピー
 * rsyncが利用可能な場合はrsyncを使用、そうでなければcpを使用
 *
 * @param sourceVolume - コピー元ボリューム名
 * @param targetVolume - コピー先ボリューム名
 * @param options - コピーオプション。`clearTarget: true` で rsync 失敗時の cp
 *   フォールバックでも target 上書き保証 (rsync は incremental: true で `--delete`、
 *   cp 側はこのオプションを `find ... -delete` に翻訳して再現する)
 * @returns コピー結果のPromise
 */
export async function copyVolume(
  sourceVolume: string,
  targetVolume: string,
  options: OwnedVolumeCopyOptions & { clearTarget?: boolean }
): Promise<void> {
  assertValidVolumeName(sourceVolume)
  assertValidVolumeName(targetVolume)
  if (sourceVolume === targetVolume) {
    throw new Error(`Refusing to copy Docker volume '${sourceVolume}' onto itself`)
  }

  if (!options?.ownership) {
    throw new Error("Volume copy requires repo/project/branch ownership metadata")
  }
  if (options.clearTarget === true && !options.recoveryDirectory) {
    throw new Error(
      "Destructive volume overwrite requires ownership and recoveryDirectory metadata"
    )
  }

  const sourceLease = acquireSourceVolumeLease(sourceVolume)
  let targetLease: TargetVolumeLease | undefined
  let operationError: unknown
  let targetWasFresh = false
  let transferAttempted = false
  let preserveTargetLease = false
  try {
    const targetPreflight = preflightTargetVolumeForCopy(targetVolume, options.ownership)
    if (targetPreflight.size > 0 && options.clearTarget !== true) {
      throw new Error(
        `Target volume '${targetVolume}' already contains data — explicit overwrite was not authorized`
      )
    }
    targetWasFresh = options.clearTarget !== true && targetPreflight.size === 0
    // A missing/recreated-empty target must exist with the expected labels before it can be
    // leased. `volume create` is idempotent; acquireTargetVolumeLease rejects a concurrent
    // foreign replacement by comparing strict ownership and full inspect snapshots.
    createVolume(targetVolume, "local", volumeLabelArgs(options))
    targetLease = acquireTargetVolumeLease(targetVolume, options.ownership, {
      temp: options.tempVolume === true,
    })

    // 既存データの上書き (clearTarget=true) は破壊的なので atomic 経路を使う。
    if (options.clearTarget === true) {
      await copyVolumeAtomicOverwrite(sourceVolume, targetVolume, options, targetLease)
    } else {
      transferAttempted = true
      try {
        await copyVolumeWithRsync(sourceVolume, targetVolume, {
          ...options,
          incremental: options.incremental,
        }, targetLease)
      } catch (error) {
        console.warn("rsync copy failed, falling back to cp:", error)
        // rsync may have left a partial fresh target; restart the fallback from empty.
        try {
          await copyVolumeWithCp(sourceVolume, targetVolume, {
            ...options,
            clearTarget: true,
          }, targetLease)
        } catch (fallbackError) {
          throw new Error(
            `rsync copy failed (${error instanceof Error ? error.message : String(error)}); cp fallback failed (${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`
          )
        }
      }
    }
  } catch (error) {
    operationError = error
    if (targetLease && targetWasFresh && transferAttempted && options.clearTarget !== true) {
      try {
        // Keep the exact target pinned while removing any partial rsync/cp tree. Only a strict
        // zero-byte re-probe turns it back into a reusable fresh target.
        assertTargetLeaseStillValid(targetLease)
        clearVolume(targetVolume)
        assertTargetLeaseStillValid(targetLease)
        const remainingBytes = getVolumeSize(targetVolume)
        if (remainingBytes === null || remainingBytes !== 0) {
          throw new Error(
            remainingBytes === null
              ? `Cannot verify cleanup of incomplete fresh target '${targetVolume}'`
              : `Incomplete fresh target '${targetVolume}' still contains ${remainingBytes} bytes after cleanup`
          )
        }
      } catch (cleanupError) {
        preserveTargetLease = true
        const stagedBytes = getVolumeSize(targetVolume) ?? 0
        let marker: StoredVolumeRecoveryRecord | undefined
        let markerError: unknown
        try {
          marker = await persistIncompleteFreshCopyRecord(
            sourceVolume,
            targetVolume,
            options.ownership,
            options.recoveryDirectory,
            stagedBytes
          )
        } catch (error) {
          markerError = error
        }
        const primaryMessage =
          operationError instanceof Error ? operationError.message : String(operationError)
        const cleanupMessage =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        operationError = new AggregateError(
          [operationError, cleanupError, ...(markerError === undefined ? [] : [markerError])],
          marker
            ? `Fresh volume copy failed (${primaryMessage}) and partial target cleanup failed (${cleanupMessage}). Recovery marker '${marker.path}' and running lease '${targetLease.containerName}' were preserved; resolve both before retrying`
            : `Fresh volume copy failed (${primaryMessage}) and partial target cleanup failed (${cleanupMessage}). Running lease '${targetLease.containerName}' was preserved because a recovery marker could not be persisted; resolve it manually before retrying`
        )
      }
    }
  }

  const cleanupErrors: Array<{ lease: "target" | "source"; error: unknown }> = []
  if (targetLease && !preserveTargetLease) {
    try {
      releaseVolumeLease(targetLease)
    } catch (error) {
      cleanupErrors.push({ lease: "target", error })
    }
  }
  try {
    releaseVolumeLease(sourceLease)
  } catch (error) {
    cleanupErrors.push({ lease: "source", error })
  }

  if (operationError !== undefined) {
    for (const cleanup of cleanupErrors) {
      console.warn(`Failed to release ${cleanup.lease} volume lease:`, cleanup.error)
    }
    throw operationError
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0].error
  if (cleanupErrors.length > 1) {
    throw new Error(
      `Failed to release target and source volume leases: ${cleanupErrors
        .map(({ lease, error }) => `${lease}: ${error instanceof Error ? error.message : String(error)}`)
        .join("; ")}`
    )
  }
}

/**
 * 既存データを持つ target を atomic に上書きする。
 *
 * 1. stage  : source を新しい空の一時 volume へ完全コピー (本番の転送)。target には
 *             一切触れないので、ここで失敗しても target の既存データは無傷。
 * 2. verify : source に中身があるのに staged コピーが空なら中断 (中途半端な上書き防止)。
 * 3. commit : ここで初めて target を消し、検証済みの一時 volume から埋め直す
 *             (ローカル間コピーなので高速で、source 側の事情では失敗しない)。
 * 4. cleanup: 一時 volume は finally で必ず削除する (best-effort)。
 *
 * Docker には volume rename が無いため真の O(1) swap は不可能。この設計は target が
 * 空になる窓を「検証済みデータからのローカルコピー」だけに最小化し、ネットワーク /
 * source 読み取りの失敗で target を空にすることは決してない。
 */
async function copyVolumeAtomicOverwrite(
  sourceVolume: string,
  targetVolume: string,
  options: OwnedVolumeCopyOptions,
  targetLease: TargetVolumeLease
): Promise<void> {
  if (!options.recoveryDirectory) {
    throw new Error(
      "Destructive volume overwrite requires ownership and recoveryDirectory metadata"
    )
  }
  const recoveryId = makeRecoveryId()
  const tmp = makeTempVolumeName(targetVolume)
  // commit (target の clear+refill) が始まったか / 完了したか。commit が始まった後に
  // 失敗した場合は target が空/中途半端で、検証済みの完全なコピーは tmp にしか無い。
  // この時 tmp を消すと唯一の正データを失うため、cleanup では tmp を残して復旧手順を出す。
  let commitStarted = false
  let commitDone = false
  let storedRecovery: StoredVolumeRecoveryRecord | undefined
  let stagedLease: SourceVolumeLease | undefined
  let releaseRepositoryLock: ReleaseRepositoryLock | undefined
  let operationError: unknown

  // mid-commit で失敗/中断した場合の復旧案内。SIGINT が finally をバイパスするため、
  // 通常の finally からも prepend した signal handler からも同じ文言を出せるよう関数化する。
  const printRecovery = (): void => {
    out(`  ⚠️  Overwrite of '${targetVolume}' failed mid-commit — its data may be incomplete.`)
    out(`      A verified full copy is preserved in temp volume '${tmp}'. Recover with:`)
    out(
      `        docker run --rm -v ${tmp}:/from -v ${targetVolume}:/to alpine sh -c 'find /to -mindepth 1 -delete && cp -a /from/. /to/' && docker volume rm ${tmp}`
    )
  }
  // commit 窓の間だけ有効化する signal handler。cli/index.ts の SIGINT/SIGTERM handler は
  // process.exit() で finally をバイパスするので、prepend した handler で復旧案内を出す
  // (tmp は finally が走らないため残る = 案内どおり復旧できる)。
  const abortSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]
  let onAbort: (() => void) | undefined

  try {
    // 1. stage
    await copyVolume(sourceVolume, tmp, {
      onProgress: options.onProgress,
      incremental: options.incremental,
      compress: options.compress,
      ownership: options.ownership,
      recoveryDirectory: options.recoveryDirectory,
      tempVolume: true,
    })
    // 2. verify — この gate だけが破壊的な commit を守る。サイズを確定できない
    //    (getVolumeSize が null) 場合は「空かもしれない」を「空でない」と誤認して
    //    target を消すことがないよう、確認できないなら必ず abort する。
    const sourceSize = getVolumeSize(sourceVolume)
    const stagedSize = getVolumeSize(tmp)
    if (sourceSize === null || stagedSize === null) {
      throw new Error(
        `Cannot verify staged copy of '${sourceVolume}' (volume size probe failed) — aborting overwrite to protect '${targetVolume}'`
      )
    }
    if (sourceSize !== stagedSize) {
      throw new Error(
        `Staged copy size mismatch for '${sourceVolume}' (source=${sourceSize}, staged=${stagedSize}) — aborting overwrite to protect '${targetVolume}'`
      )
    }
    // Staging can be slow, so it deliberately happens without the repository lock. Only the
    // publication -> destructive commit -> verification -> record/temp cleanup window must be
    // serialized with `prune --yes`. The supported recovery path uniquely identifies the common
    // Git directory and therefore the same lock used by prune/create.
    const commonGitDir = commonGitDirectoryFromRecoveryDirectory(options.recoveryDirectory)
    releaseRepositoryLock = await acquireRepositoryLock(commonGitDir)

    // Revalidate both sides after acquiring the repository lock. The stopped target lease has
    // pinned the exact target volume throughout staging; checking its snapshot and running users
    // here prevents a stale pre-lock decision from entering the destructive window.
    const activeTargetHolders = getRunningVolumeHoldersOrThrow(targetVolume).filter(
      (holder) => holder.id !== targetLease.containerId
    )
    if (activeTargetHolders.length > 0) {
      throw new Error(
        `Target volume '${targetVolume}' is in use by ${activeTargetHolders.map((holder) => holder.name).join(", ")} — refusing to enter the atomic commit window`
      )
    }
    assertTargetLeaseStillValid(targetLease)

    const stagedOwnership = inspectVolumeOwnership(tmp)
    if (
      !stagedOwnership.temp ||
      !volumeOwnershipMatches(stagedOwnership, options.ownership)
    ) {
      throw new Error(
        `Staged volume '${tmp}' lost its expected temporary ownership before commit — refusing to overwrite '${targetVolume}'`
      )
    }
    const activeStagedHolders = getContainersUsingVolumeOrThrow(tmp)
    if (activeStagedHolders.length > 0) {
      throw new Error(
        `Staged volume '${tmp}' is unexpectedly in use by ${activeStagedHolders.join(", ")} — refusing to overwrite '${targetVolume}'`
      )
    }
    stagedLease = acquireSourceVolumeLease(tmp)

    // Re-probe after the lock (and after pinning the staged volume). A prune that completed just
    // before our lock acquisition, or an external replacement, must not let pre-lock byte counts
    // authorize target deletion.
    const lockedSourceSize = getVolumeSize(sourceVolume)
    const lockedStagedSize = getVolumeSize(tmp)
    if (lockedSourceSize === null || lockedStagedSize === null) {
      throw new Error(
        `Cannot revalidate staged copy of '${sourceVolume}' after acquiring the repository lock — aborting overwrite to protect '${targetVolume}'`
      )
    }
    if (lockedSourceSize !== lockedStagedSize) {
      throw new Error(
        `Staged copy changed before commit for '${sourceVolume}' (source=${lockedSourceSize}, staged=${lockedStagedSize}) — aborting overwrite to protect '${targetVolume}'`
      )
    }

    // 3. destructive commit の直前に、検証済み temp から戻せる永続 record を common
    //    Git directory 配下へ原子的に保存する。record 公開前には target を一切触らない。
    const recoveryRecord: VolumeRecoveryRecord = {
      version: 1,
      kind: "atomic-overwrite",
      id: recoveryId,
      createdAt: new Date().toISOString(),
      sourceVolume,
      targetVolume,
      tempVolume: tmp,
      sourceBytes: lockedSourceSize,
      stagedBytes: lockedStagedSize,
      ownership: options.ownership,
    }
    const expectedRecoveryPath = path.join(options.recoveryDirectory, `${recoveryId}.json`)
    try {
      storedRecovery = writeVolumeRecoveryRecord(options.recoveryDirectory, recoveryRecord)
    } catch (error) {
      // rename 後の directory fsync だけが失敗した場合、record は既に可視になっている。
      // その時は temp を削除せず、record が指す復旧データを必ず残す。
      if (existsSync(expectedRecoveryPath)) {
        storedRecovery = { path: expectedRecoveryPath, record: recoveryRecord }
      }
      throw error
    }

    // 4. commit (target を消すのはここが初めて)。この窓の間は SIGINT でも復旧案内を出す。
    onAbort = () => printRecovery()
    for (const sig of abortSignals) process.prependListener(sig, onAbort)
    commitStarted = true
    await copyVolumeWithCp(
      tmp,
      targetVolume,
      {
        clearTarget: true,
        ownership: options.ownership,
      },
      targetLease
    )
    const committedSize = getVolumeSize(targetVolume)
    const verifiedStagedSize = getVolumeSize(tmp)
    if (
      committedSize === null ||
      verifiedStagedSize === null ||
      committedSize !== verifiedStagedSize
    ) {
      throw new Error(
        `Committed volume size mismatch for '${targetVolume}' (target=${committedSize ?? "unknown"}, staged=${verifiedStagedSize ?? "unknown"}) — preserving recovery data`
      )
    }
    commitDone = true
    // target の refill が完了した後だけ record を消す。ここが失敗したら record と temp を
    // 保持し、prune が誤削除できない状態のまま呼び出し側へエラーを返す。
    removeVolumeRecoveryRecord(storedRecovery.path)
    storedRecovery = undefined
  } catch (error) {
    operationError = error
  } finally {
    if (onAbort) {
      for (const sig of abortSignals) process.removeListener(sig, onAbort)
    }

    const cleanupErrors: Array<{ action: string; error: unknown }> = []
    if (stagedLease) {
      try {
        releaseVolumeLease(stagedLease)
      } catch (error) {
        cleanupErrors.push({ action: "release staged volume lease", error })
      }
    }
    // 5. cleanup。commit 開始後に失敗した場合だけは tmp を残す (target が壊れていて
    //    tmp が唯一の完全コピーのため)。それ以外 (staging/verify 失敗 = target 無傷、
    //    または commit 成功) では tmp は不要なので削除する。
    if (commitStarted && !commitDone) {
      printRecovery()
    } else if (storedRecovery) {
      // record が可視な状態では、それが指す temp を必ず残す。
      out(
        commitDone
          ? `  ⚠️  Volume data was copied, but recovery record cleanup failed; preserving '${tmp}' for safety.`
          : `  ⚠️  Recovery record persistence was incomplete; preserving staged volume '${tmp}' for safety.`
      )
    } else {
      removeVolume(tmp)
    }

    // Temp cleanup is part of the critical window: only now may destructive prune observe the
    // repository again. A release failure is surfaced on an otherwise-successful copy, while an
    // existing copy error remains the primary error.
    if (releaseRepositoryLock) {
      try {
        await releaseRepositoryLock()
      } catch (error) {
        cleanupErrors.push({ action: "release repository lock", error })
      }
    }
    if (cleanupErrors.length > 0) {
      if (operationError !== undefined) {
        for (const cleanup of cleanupErrors) {
          console.warn(`Failed to ${cleanup.action}:`, cleanup.error)
        }
      } else if (cleanupErrors.length === 1) {
        operationError = cleanupErrors[0].error
      } else {
        operationError = new Error(
          `Volume overwrite cleanup failed: ${cleanupErrors
            .map(
              ({ action, error }) =>
                `${action}: ${error instanceof Error ? error.message : String(error)}`
            )
            .join("; ")}`
        )
      }
    }
  }
  if (operationError !== undefined) throw operationError
}

/**
 * バイト数を人間が読みやすい形式にフォーマット
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"

  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / 1024 ** i

  return `${value.toFixed(2)} ${units[i]}`
}

/**
 * 秒数を人間が読みやすい形式にフォーマット
 */
export function formatEta(seconds: number): string {
  if (seconds <= 0) return "--:--"

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`
}

// Re-export FILE_ENCODING for backward compat
export { FILE_ENCODING }

/**
 * 解決された volume の情報
 */
export interface ResolvedVolume {
  /** 実 Docker volume 名 */
  name: string
  /** external (共有意図) かどうか */
  external: boolean
}

/**
 * Compose ファイル内の volume key から、実 Docker volume 名を解決する
 *
 * 規則 (compose-spec v2 準拠):
 * - `volumes.<key>.external: true` で `name` 未指定 → `{ name: <key>, external: true }`
 *   (compose-spec: external で名前未指定なら key 自体が外部 volume 名)
 * - `volumes.<key>.external: { name: "foo" }` → `{ name: "foo", external: true }`
 * - `volumes.<key>.external: true` + `volumes.<key>.name: "foo"` → `{ name: "foo", external: true }`
 * - `volumes.<key>.name: "foo"` (external なし) → `{ name: "foo", external: false }`
 * - 上記なし (空オブジェクト or null) → `{ name: "<projectName>_<key>", external: false }`
 *
 * @param composeConfig - パース済 compose 設定
 * @param volumeKey - compose の volumes セクションの key
 * @param projectName - Docker Compose project name (ディレクトリ名から導出)
 * @returns 解決結果。共有意図で名前不定なら null
 */
export function resolveVolumeName(
  composeConfig: ComposeConfig,
  volumeKey: string,
  projectName: string
): ResolvedVolume | null {
  const volumes = composeConfig.volumes
  if (!volumes || !(volumeKey in volumes)) {
    return null
  }

  const entry = volumes[volumeKey]

  // 空のエントリ (volume_name: のみ) は { name: <project>_<key> }
  if (entry === null || entry === undefined) {
    return { name: `${projectName}_${volumeKey}`, external: false }
  }

  if (typeof entry !== "object") {
    return { name: `${projectName}_${volumeKey}`, external: false }
  }

  // external フィールドの解釈
  let isExternal = false
  let externalName: string | undefined

  if (entry.external === true) {
    isExternal = true
  } else if (entry.external && typeof entry.external === "object") {
    isExternal = true
    if (typeof entry.external.name === "string") {
      externalName = entry.external.name
    }
  }

  // name フィールドの優先順位
  const explicitName: string | undefined =
    typeof entry.name === "string" ? entry.name : externalName

  if (isExternal) {
    if (!explicitName) {
      // external で名前不定 → key 自体が外部 volume 名
      // (compose-spec: external: true で名前未指定なら key がそのまま使われる)
      return { name: volumeKey, external: true }
    }
    return { name: explicitName, external: true }
  }

  if (explicitName) {
    return { name: explicitName, external: false }
  }

  return { name: `${projectName}_${volumeKey}`, external: false }
}

/**
 * Docker Compose の `volumes:` セクションから、クローン対象の named volume key 一覧を抽出
 *
 * - external な volume は除外 (共有意図)
 * - exclude に含まれる key は除外
 *
 * @param composeConfig - パース済 compose 設定
 * @param exclude - 除外する key 一覧
 * @returns クローン対象の volume key 配列
 */
export function discoverCloneableVolumes(
  composeConfig: ComposeConfig,
  exclude: string[] = []
): string[] {
  if (!composeConfig.volumes) return []
  const excludeSet = new Set(exclude)
  const result: string[] = []
  for (const key of Object.keys(composeConfig.volumes)) {
    if (excludeSet.has(key)) continue
    const entry = composeConfig.volumes[key]
    if (entry && typeof entry === "object") {
      if (entry.external === true || (entry.external && typeof entry.external === "object")) {
        continue // external は対象外
      }
    }
    result.push(key)
  }
  return result
}

/**
 * 指定 volume を使用している稼働中コンテナの一覧を取得
 *
 * @param volumeName - 検査対象の Docker volume 名
 * @returns 該当する running container 名一覧
 */
export function getContainersUsingVolume(volumeName: string): string[] {
  try {
    const output = execDockerSafe(
      ["ps", "--filter", `volume=${volumeName}`, "--format", "{{.Names}}"],
      {}
    )
    if (!output) return []
    return output
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  } catch {
    return []
  }
}

/**
 * 指定 volume を使用している稼働中コンテナを、所属 Compose project 付きで取得する。
 *
 * `docker ps --filter volume=X --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}'`
 * を解析する。compose 管理外のコンテナや label が無い場合は `project: null`。
 * これにより「source スタックを停止しても解放されない別 project が掴んでいる volume」を
 * 検出して、無駄に source を止めずに skip できる。
 *
 * @param volumeName - 検査対象の Docker volume 名
 * @returns 該当コンテナの { name, project } 一覧 (取得失敗時は空配列)
 */
export function getContainersUsingVolumeWithProject(
  volumeName: string
): Array<{ name: string; project: string | null }> {
  try {
    const output = execDockerSafe(
      [
        "ps",
        "--filter",
        `volume=${volumeName}`,
        "--format",
        '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
      ],
      {}
    )
    if (!output) return []
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const tabIdx = line.indexOf("\t")
        if (tabIdx === -1) {
          return { name: line, project: null }
        }
        const name = line.slice(0, tabIdx).trim()
        const projectRaw = line.slice(tabIdx + 1).trim()
        return { name, project: projectRaw.length > 0 ? projectRaw : null }
      })
      .filter((entry) => entry.name.length > 0)
  } catch {
    return []
  }
}

/** Strict variant used before copy/stop decisions; Docker errors are never treated as no holders. */
export function getContainersUsingVolumeWithProjectOrThrow(
  volumeName: string
): Array<{ name: string; project: string | null }> {
  assertValidVolumeName(volumeName)
  const output = execDockerSafe(
    [
      "ps",
      "--filter",
      `volume=${volumeName}`,
      "--format",
      '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
    ],
    {}
  )
  if (!output) return []
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tabIndex = line.indexOf("\t")
      if (tabIndex < 0) return { name: line, project: null }
      const name = line.slice(0, tabIndex).trim()
      const project = line.slice(tabIndex + 1).trim()
      return { name, project: project || null }
    })
    .filter((entry) => entry.name.length > 0)
}

/**
 * Docker volume が存在するかをチェック
 */
export function volumeExists(volumeName: string): boolean {
  try {
    execDockerSafe(["volume", "inspect", volumeName], {})
    return true
  } catch {
    return false
  }
}
