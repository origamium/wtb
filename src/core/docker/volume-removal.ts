/**
 * @fileoverview Fail-closed ownership checks for destructive Compose volume removal.
 */

import { getErrorMessage } from "../../utils/error.js"
import type { ComposeConfig } from "../../types/index.js"
import { assertComposeStorageDefinitionsSafe, readComposeFile } from "./compose.js"
import {
  getVolumeRecoveryDirectory,
  inspectVolumeOwnership,
  readVolumeRecoveryRecords,
  repoVolumeLabel,
  resolveVolumeName,
  volumeExistsOrThrow,
  volumeOwnershipMatches,
} from "./volume.js"

/** Docker could not prove whether a volume exists or who owns it. */
export class DockerVolumeInspectionError extends Error {}

/**
 * Resolve every named, non-external volume exactly as Compose will and verify that an existing
 * volume belongs exclusively to the requested worktree before allowing `docker compose down -v`.
 *
 * Absence is safe: Compose has nothing to remove. Any Docker query/inspect failure is not treated
 * as absence, because doing so would turn a daemon outage into permission to delete unknown data.
 */
export function assertComposeVolumesSafeForRemoval(
  composeFilePath: string,
  mainRoot: string,
  projectName: string,
  branch: string,
  commonGitDir: string
): ComposeConfig {
  const composeConfig = readComposeFile(composeFilePath)
  assertComposeStorageDefinitionsSafe(composeConfig)
  const expected = {
    repo: repoVolumeLabel(mainRoot),
    project: projectName,
    branch,
  }
  const volumeNames = new Set<string>()

  for (const volumeKey of Object.keys(composeConfig.volumes ?? {})) {
    const resolved = resolveVolumeName(composeConfig, volumeKey, projectName)
    if (resolved && !resolved.external) volumeNames.add(resolved.name)
  }

  const recoveringTargets = new Set(
    readVolumeRecoveryRecords(getVolumeRecoveryDirectory(commonGitDir)).map(
      ({ record }) => record.targetVolume
    )
  )
  for (const volumeName of volumeNames) {
    if (recoveringTargets.has(volumeName)) {
      throw new Error(
        `Refusing to remove volume '${volumeName}': an unresolved recovery record still protects it`
      )
    }
  }

  for (const volumeName of volumeNames) {
    let exists: boolean
    try {
      exists = volumeExistsOrThrow(volumeName)
    } catch (error) {
      throw new DockerVolumeInspectionError(
        `Cannot determine whether volume '${volumeName}' exists: ${getErrorMessage(error)}`
      )
    }
    if (!exists) continue

    let actual: ReturnType<typeof inspectVolumeOwnership>
    try {
      actual = inspectVolumeOwnership(volumeName)
    } catch (error) {
      throw new DockerVolumeInspectionError(
        `Cannot inspect ownership of volume '${volumeName}': ${getErrorMessage(error)}`
      )
    }

    if (!volumeOwnershipMatches(actual, expected) || actual.temp) {
      throw new Error(
        `Refusing to remove volume '${volumeName}': it is unmanaged, foreign, shared, or temporary`
      )
    }
  }
  return composeConfig
}
