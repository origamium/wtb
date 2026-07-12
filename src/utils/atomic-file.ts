/**
 * Crash-resistant same-directory file replacement.
 *
 * Data is written to an exclusively-created temporary file, flushed, and then
 * renamed over the destination.  A pre-existing destination's permission bits
 * are retained.  The temporary file is removed on every pre-rename failure.
 */

import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export interface AtomicWriteFileOptions {
  encoding?: BufferEncoding
  /** Mode for a new destination. Existing destination mode always wins. */
  mode?: number
}

function existingMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function temporaryPath(filePath: string): string {
  const suffix = randomBytes(8).toString("hex")
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${suffix}.tmp`)
}

/** Atomically replace `filePath` with `data` using a temporary sibling. */
export function atomicWriteFileSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: AtomicWriteFileOptions = {}
): void {
  const destinationMode = existingMode(filePath)
  const requestedMode = destinationMode ?? options.mode
  const creationMode = requestedMode ?? 0o666
  const tempPath = temporaryPath(filePath)
  let fd: number | undefined
  let ownsTemp = false

  try {
    fd = fs.openSync(tempPath, "wx", creationMode)
    ownsTemp = true
    fs.writeFileSync(fd, data, { encoding: options.encoding ?? "utf8" })
    // chmod after writing as well: it makes preservation explicit even on
    // platforms/filesystems that apply additional creation-mode restrictions.
    if (requestedMode !== undefined) {
      fs.fchmodSync(fd, requestedMode)
    }
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tempPath, filePath)
    ownsTemp = false
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the original operation error.
      }
    }
    if (ownsTemp) {
      try {
        fs.unlinkSync(tempPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          // Preserve the original operation error; a stale temp is safer than
          // masking the write failure with a cleanup failure.
        }
      }
    }
    throw error
  }
}
