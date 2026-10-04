# README contract and verification

This checklist maps the English/Japanese README promises to executable coverage. It records the verification boundary, not a claim that every environment-dependent test has run on the reader's machine. Run the commands below and retain their output for a release.

| Contract | Coverage |
|----------|----------|
| Config lookup/defaults, complete fields, repository-relative paths, symlink rejection | `src/core/config/{loader,validator,paths}.test.ts` |
| Main/current/common Git identity from linked worktrees, repository locking | `src/core/git/repository.context.integration.test.ts`, `repository.test.ts` |
| Local/remote/new branch resolution, checkout preservation, dry-run | `src/cli/commands/create.branch.test.ts`, `e2e/cli.test.ts` |
| Copy/link priority, transactional writes, optional missing files, strict errors | `src/cli/commands/create.file-setup.test.ts`, `src/utils/atomic-file.test.ts` |
| Env adjustment, literal/null values, port reservation and propagation | `src/core/environment/{processor,propagate}.test.ts`, `src/cli/commands/create.env-propagation.test.ts` |
| Target Compose precedence, project/container identity, network/port safety | `src/cli/commands/create.compose.test.ts`, `src/core/docker/{compose,project-ownership}.test.ts` |
| Named-volume clone/seed, source stop/restart recovery, ownership and recovery protection | `src/cli/commands/create.volume.test.ts`, `src/core/docker/volume.test.ts`, `src/cli/commands/{reclone,prune}.test.ts` |
| Removal dirty/locked/main guards, partial cleanup, owned-volume-only deletion | `src/cli/commands/{remove,updown,prune}.test.ts` |
| Ports, env interpolation, status, doctor and Claude skill installation | `src/cli/commands/{ports,status,doctor,init-claude}.test.ts`, `src/cli/utils/claude-skill-install.test.ts` |
| Readiness: replicas, healthy/running/completed jobs, pending services, timeouts and Docker failures | `src/core/docker/readiness.test.ts`, `src/cli/commands/await.test.ts` |
| `ls --full`: base comparison, detached/missing refs and unknown states | `src/core/git/full-status.test.ts`, `src/cli/commands/ls.test.ts` |
| `env`: adjusted keys only, later-file precedence, shell quoting and JSON | `src/cli/commands/env.test.ts` |
| Orca installer: exact hooks, opt-in volume deletion, comment preservation, force scope, check/dry-run, root/symlink/anchor guards | `src/cli/utils/orca-install.test.ts`, `src/cli/commands/init-orca.test.ts` |
| Existing-worktree setup: repeated/concurrent setup, local data protection, failed-start manual recovery, readiness retries | `e2e/orca-setup.test.ts`, `src/cli/commands/setup.test.ts`, `src/core/environment/setup-state.test.ts` |
| Environment teardown: hook before guarded down, ownership revalidation, partial failure, no Git deletion | `src/cli/commands/teardown.test.ts` |
| JSON stdout and exit codes, including early failures | `src/cli/commands/create.json.test.ts`, per-command tests, `src/cli/index.test.ts`, `e2e/cli.test.ts`, `e2e/orca-setup.test.ts` |

## Running checks

```sh
npm run typecheck
npm run lint
npm run test:run
npm run test:integration
```

The first test suite contains unit tests and subprocess CLI scenarios. Docker integration scripts require a working Docker daemon and Compose plugin; they exercise real resources and database data. `e2e/integration-orca.sh` exercises the wtb hooks against disposable Docker resources without invoking Orca itself. Do not report a skipped or failed Docker run as a passing integration check. Node.js 18 is the supported minimum; verify a built CLI with that runtime as well as the development runtime when preparing a release.

During implementation verification, the Docker lifecycle, PostgreSQL/MySQL data, and Orca-hook integration scripts all passed. An earlier database run refused startup because a volume-size probe failed; the failure did not reproduce on the subsequent database and Orca-hook runs. Its cause remains undetermined. Probe failures now retain the underlying Docker error on stderr and still refuse unsafe operations; they are not treated as empty volumes or silently retried.

## Orca verification boundary

Hook schema, environment names, startup policy, CLI hook opt-in, and the 120-second archive deadline were inspected in the installed Orca 1.4.219 bundle. The installer and lifecycle tests do not require Orca's private application state or CLI. They validate the repository side of the integration.

A live Orca create → setup → readiness → archive cycle remains a separate acceptance check. In the development session, the selected `/usr/local/bin/orca` failed with `Unable to determine Orca.app path from symlink: /usr/local/bin/orca`; live Orca execution was therefore not verified. No alternate binary or machine configuration was substituted. After that installation issue is corrected, validate on a disposable project with shared hooks enabled:

1. Create via Orca with setup enabled. Verify `wtb setup` finishes and agents wait for readiness.
2. Verify assigned ports and copied database data are independent of main.
3. Repeat completed setup. Verify ports, seed/start effects, and target data do not change.
4. Make setup/readiness fail. Verify non-zero status and that interrupted preparation requires inspection rather than automatic replay.
5. Archive with hooks enabled. Verify the checkout remains until cleanup succeeds and only the selected worktree's owned volumes are deleted when configured.
6. Make archive fail. Verify an archive-failure-blocking Orca runtime preserves the checkout; inspect partial cleanup because preserving files does not restore data already removed.

`init-orca --check` verifies shared file contents only. It cannot prove Orca's local command-source/run policy, host PATH, daemon availability, or runtime archive-failure capability.
