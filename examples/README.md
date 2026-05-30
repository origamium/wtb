# wtb examples

Five self-contained projects that exercise different slices of wtb, plus a runner
that drives the real CLI against any of them in a throwaway git repo — so you can
judge production-readiness on realistic configs, not just docs.

## The examples

| Example | Docker Compose | Volumes cloned | `link_files` | Notable features |
|---------|:---:|---|:---:|---|
| [`compose-fullstack`](compose-fullstack/) | ✅ 4 services | `pg_data`, `redis_data` | ✅ `node_modules` | 4 ports remapped, lifecycle scripts — the full surface |
| [`compose-minimal`](compose-minimal/) | ✅ 1 service | `db_data` | — | smallest real DB clone (stop-then-copy) |
| [`compose-seed`](compose-seed/) | ✅ 2 services | `db_data` only | — | `volumes.exclude`, `external: true`, `--seed` |
| [`node-no-docker`](node-no-docker/) | ❌ | — | ✅ `node_modules` | no-Docker path: copy + symlink + all 3 `env.adjust` types + `start_command` |
| [`minimal`](minimal/) | ❌ | — | — | bare baseline: copy `.env` + bump one port |

Coverage across the set: every `create` phase, both Docker and non-Docker paths,
volume cloning + exclude + external + seed, all three `env.adjust` value types,
symlinks vs copies, and lifecycle scripts.

## Run wtb against one

The runner copies an example into a temp dir, `git init`s it, and runs the locally
built wtb CLI. Default is a **dry-run** (no side effects); add `--real` to actually
create the worktree.

```bash
# from the repo root
examples/try.sh                                  # list the examples
examples/try.sh minimal                          # dry-run the plan
examples/try.sh node-no-docker feature/x --real  # real worktree (no Docker needed)
examples/try.sh compose-minimal feature/db --real     # real (needs Docker; clones db_data)
examples/try.sh compose-seed feature/fresh --real --seed   # seed a fresh DB instead of cloning
```

`--real` runs print `wtb ls -l` and `wtb ports --pretty` afterwards so you can see
the assigned ports and the new worktree. The Docker examples use only prebuilt
images (postgres/redis/nginx/node alpine), so the stacks come up fast.

> The examples are plain project directories — they become git repos only inside
> the temp workdir the runner creates, so nothing here is a nested repo in the wtb
> tree.
