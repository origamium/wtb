export interface ComposeContainerState {
  id: string
  name: string
  service: string
  state: string
  health: string
  exitCode: number | null
}

export interface ExpectedComposeService {
  name: string
  replicas: number
  healthcheck: boolean
  job: boolean
}

export interface ServiceReadiness {
  service: string
  expectedReplicas: number
  ready: boolean
  containers: (ComposeContainerState & { ready: boolean })[]
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object")
  return value as Record<string, unknown>
}

/** Compose versions have emitted both a JSON array and one object per line. */
export function parseComposePs(output: string): ComposeContainerState[] {
  const text = output.trim()
  if (!text) return []
  let rows: unknown[]
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error("Invalid Compose ps response")
    rows = parsed
  } else {
    rows = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  return rows.map((row) => {
    const value = object(row)
    if (typeof value.Service !== "string" || !value.Service || typeof value.State !== "string") {
      throw new Error("Compose ps response is missing Service or State")
    }
    return {
      id: typeof value.ID === "string" ? value.ID : "",
      name: typeof value.Name === "string" ? value.Name : "",
      service: value.Service,
      state: value.State.toLowerCase(),
      health: typeof value.Health === "string" ? value.Health.toLowerCase() : "",
      exitCode:
        typeof value.ExitCode === "number" && Number.isInteger(value.ExitCode)
          ? value.ExitCode
          : null,
    }
  })
}

/** Read normalized Compose config without ever exposing its environment/secrets. */
export function expectedComposeServices(
  output: string,
  profiles: string[] = []
): ExpectedComposeService[] {
  const config = object(JSON.parse(output))
  const services = object(config.services ?? {})
  const active = new Set(profiles)
  const entries = Object.entries(services)
    .map(([name, raw]) => [name, object(raw)] as const)
    .filter(
      ([, service]) =>
        !Array.isArray(service.profiles) ||
        service.profiles.length === 0 ||
        active.has("*") ||
        service.profiles.some((profile) => typeof profile === "string" && active.has(profile))
    )
  const completedJobs = new Set<string>()
  for (const [, service] of entries) {
    if (
      service.depends_on &&
      typeof service.depends_on === "object" &&
      !Array.isArray(service.depends_on)
    ) {
      for (const [name, condition] of Object.entries(service.depends_on)) {
        if (
          condition &&
          typeof condition === "object" &&
          "condition" in condition &&
          condition.condition === "service_completed_successfully"
        )
          completedJobs.add(name)
      }
    }
  }
  return entries
    .map(([name, service]) => {
      const deploy = service.deploy ? object(service.deploy) : {}
      const rawReplicas = service.scale ?? deploy.replicas ?? 1
      if (typeof rawReplicas !== "number" || !Number.isInteger(rawReplicas) || rawReplicas < 0) {
        throw new Error(`Invalid replica count for Compose service '${name}'`)
      }
      const health = service.healthcheck ? object(service.healthcheck) : undefined
      return {
        name,
        replicas: rawReplicas,
        healthcheck: Boolean(
          health &&
            health.disable !== true &&
            !(Array.isArray(health.test) && health.test[0] === "NONE")
        ),
        job:
          completedJobs.has(name) ||
          deploy.mode === "replicated-job" ||
          deploy.mode === "global-job",
      }
    })
    .filter((service) => service.replicas > 0)
}

export function evaluateReadiness(
  expected: ExpectedComposeService[],
  rows: ComposeContainerState[]
): ServiceReadiness[] {
  return expected.map((service) => {
    const containers = rows
      .filter((row) => row.service === service.name)
      .map((row) => ({
        ...row,
        ready: service.job
          ? row.state === "exited" && row.exitCode === 0
          : row.state === "running" &&
            (row.health === "healthy" || (!row.health && !service.healthcheck)),
      }))
    return {
      service: service.name,
      expectedReplicas: service.replicas,
      ready: containers.length >= service.replicas && containers.every((row) => row.ready),
      containers,
    }
  })
}

export async function pollComposeReadiness(
  expected: ExpectedComposeService[],
  read: () => ComposeContainerState[],
  deadline: number,
  options: {
    now?: () => number
    sleep?: (ms: number) => Promise<unknown>
    intervalMs?: number
  } = {}
): Promise<{ ok: boolean; timedOut: boolean; services: ServiceReadiness[] }> {
  if (expected.length === 0) throw new Error("No active Compose services to await")
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let services: ServiceReadiness[] = []
  while (now() < deadline) {
    services = evaluateReadiness(expected, read())
    if (now() < deadline && services.every((service) => service.ready)) {
      return { ok: true, timedOut: false, services }
    }
    const remaining = deadline - now()
    if (remaining > 0) await sleep(Math.min(options.intervalMs ?? 1000, remaining))
  }
  return { ok: false, timedOut: true, services }
}
