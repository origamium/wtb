# wtb Architecture

`wtb` は **Git worktree ごとに Docker Compose 環境を分離する CLI** です。
1 リポジトリ内の複数ブランチをポート競合なしに同時に立ち上げ、`.env` の値を worktree ごとに自動調整し、Claude Code から worktree 固有のポートを発見可能にします。

対象バージョン: **1.2.0** (`@schemelisp/wtb`)

---

## ディレクトリ構造

```
src/
├── index.ts                         # エクスポート集約（cli/index から再エクスポート）
├── cli/
│   ├── index.ts                     # Commander プログラム生成・エラーハンドリング・main()
│   ├── commands/                    # サブコマンド実装（1 ファイル = 1 コマンド）
│   │   ├── create.ts                # wtb create — worktree 構築パイプライン（clone/--seed）
│   │   ├── remove.ts                # wtb remove — Docker teardown / end_command / worktree 削除（--json）
│   │   ├── reclone.ts               # wtb reclone — 既存 worktree の volume クローンのみ再実行
│   │   ├── updown.ts                # wtb up / down — worktree 自身の project 名で compose up/down
│   │   ├── prune.ts                 # wtb prune — 孤児/残骸 wtb-managed volume の掃除
│   │   ├── ls.ts                    # wtb ls   — worktree 一覧（-l で並列 enrichment）
│   │   ├── path.ts                  # wtb path — ブランチ名 → worktree 絶対パス 1 行出力
│   │   ├── ports.ts                 # wtb ports — 調整後ポート/エンドポイント表示
│   │   ├── status.ts                # wtb status — worktree + Docker 状態（--json で機械可読）
│   │   ├── init.ts                  # wtb init — コメント付き wtb.yaml テンプレート生成
│   │   ├── init-claude.ts           # wtb init-claude — Claude Skill 配置
│   │   ├── doctor.ts                # wtb doctor — 静的 relocatability preflight（create も再利用）
│   │   └── *.test.ts
│   └── utils/                       # CLI 出力レンダリング & インストーラ
│       ├── worktree-render.ts       # ls 用 pure renderer (default/-l/--json/-p)
│       ├── ports-render.ts          # ports 用 pure renderer (JSON / pretty)
│       ├── doctor-render.ts         # doctor 用 pure renderer (JSON / pretty)
│       ├── claude-skill-install.ts  # SKILL.md テンプレートのコピー処理
│       ├── command-helpers.ts       # withErrorHandling — CLIError → exit code の共通ハンドラ
│       ├── progress.ts              # 進捗表示 (creates 用)
│       └── *.test.ts
├── core/                            # ドメインロジック（CLI 非依存）
│   ├── index.ts
│   ├── config/
│   │   ├── loader.ts                # findConfigFile / loadConfig / mergeWithDefaults
│   │   ├── validator.ts             # validateConfig (errors throw, warnings → stderr)
│   │   └── paths.ts                 # repository-relative path 検証 + runtime containment
│   ├── git/
│   │   ├── repository.ts            # RepositoryContext + main 解決 + repository lock
│   │   ├── worktree.ts              # listWorktrees / createWorktree / removeWorktree (porcelain parser)
│   │   └── commit-info.ts           # enrichWorktree (ls -l 用: shortHash/age/dirty)
│   ├── docker/
│   │   ├── client.ts                # getRunningContainers / getDockerVolumes / getUsedPorts / isWtbContainer
│   │   ├── compose.ts               # read/write・ポート調整・identity rewrite・project 名解決・compose up/down
│   │   ├── interpolation.ts         # compose 値の ${VAR:-default} 展開（doctor / propagation 用）
│   │   ├── locate.ts                # resolveComposePath — 設定 or 自動検出で compose ファイルを特定
│   │   ├── relocatability.ts        # analyzeRelocatability — doctor の静的解析本体
│   │   └── volume.ts                # ボリュームユーティリティ
│   └── environment/
│       ├── env-map.ts               # buildWorktreeEnvMap — env ファイル群の値マップ構築（doctor 用）
│       ├── processor.ts             # parseEnvFile / copyAndAdjustEnvFile (順序保存・null 削除)
│       └── propagate.ts             # buildPortMap / propagatePortsInValue — 旧→新ポートの参照伝播
├── utils/
│   ├── exec.ts                      # execSafeSync / execGitSafe / execDockerSafe / executeLifecycleCommand
│   ├── atomic-file.ts               # same-directory temp + fsync + rename writer
│   └── error.ts                     # getErrorMessage / CLIError
├── constants/
│   └── index.ts                     # APP_NAME, CONFIG_FILE_NAMES, WTB_PREFIX, PORT_RANGE …
├── types/
│   └── index.ts                     # 全 interface 定義
└── test/
    ├── setup.ts                     # vitest セットアップ
    ├── helpers/
    │   ├── git-test-helper.ts       # createWtbConfig など
    │   └── docker-test-helper.ts
    └── fixtures/
        └── docker-project/          # docker-compose + init-db フィクスチャ

e2e/
├── cli.test.ts                      # CLI を子プロセスで起動するシナリオテスト (101 件)
├── helpers.ts                       # createTestRepo / runCLI / cleanup
└── projects/                        # フィクスチャプロジェクト（basic, edge-cases, env-adjust,
                                     # full-featured, link-files, missing-files, no-docker）

templates/
└── claude/skills/wtb/SKILL.md       # init-claude が配布する Skill 定義

sample/
├── docker-compose.yml               # PostgreSQL + Next.js + Debian の見本
├── wtb.yaml                         # ポート調整・env.adjust 例
├── start-dev.sh / stop-dev.sh
├── next-app/                        # Next.js アプリ
└── README.md
```

---

## レイヤと依存関係

```
              cli/commands ──┐
                             ├──► core/* ──► utils/*
              cli/utils    ──┘
                                       │
                  ┌────────────────────┴────────────────────┐
                  ▼                                         ▼
              types/index                              constants/index
```

- **CLI 層** (`src/cli/`) は Commander で引数解析し、core を呼び出して結果をレンダリングする。プロセス終了コードと標準出力管理を担う。
- **Core 層** (`src/core/`) は CLI に非依存のドメインロジック。Git / Docker / 設定 / 環境変数処理。
- **Utils 層** (`src/utils/`) は外部コマンド実行とエラー整形のみ。
- **Types** と **Constants** はすべての層から参照可能。逆方向の依存は禁止。

---

## 公開 API（モジュール別）

すべて ES Module。import パスはビルド後の `.js` 拡張子で記述（例: `from "../core/git/repository.js"`）。

### `src/constants/index.ts`

| 名前 | 値 / 意味 |
| --- | --- |
| `APP_NAME` | `"wtb"` |
| `APP_VERSION` | `package.json` から動的取得（現状 `"1.2.0"`） |
| `APP_DESCRIPTION` | CLI 説明文 |
| `CONFIG_FILE_NAMES` | `["wtb.yaml", "wtb.yml", ".wtb.yaml", ".wtb.yml", ".wtb/config.yaml", ".wtb/config.yml"]` |
| `DEFAULT_CONFIG` | 設定のデフォルト値（`base_branch: "main"`, `env.file: ["./.env"]` …） |
| `COMPOSE_FILE_NAMES` | `["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]` |
| `ENV_FILE_NAMES` | `[".env", ".env.local", ".env.development", ".env.production"]` |
| `DOCKER_COMMANDS` | `docker ps` / `docker inspect` / `docker volume ls` / `docker --version` 等のコマンド文字列 |
| `PORT_RANGE` | `{ MIN: 3000, MAX: 9999, SEARCH_LIMIT: 100 }` |
| `EXIT_CODES` | `SUCCESS=0` / `GENERAL_ERROR=1` / `INVALID_USAGE=2` / `NOT_GIT_REPOSITORY=3` / `CONFIG_ERROR=4` / `DOCKER_ERROR=5` / `WORKTREE_EXISTS=6` |
| `LOG_LEVELS` | `error / warn / info / debug` |
| `ENV_VAR_PATTERNS` | 環境変数名のバリデーション用正規表現一式 |
| `WTB_PREFIX` | `"WTB_"` — wtb 由来コンテナ識別用 env プレフィックス |
| `FILE_ENCODING` | `"utf-8"` |
| `TEMP_DIR_PREFIX` | `"wtb-"` |
| `BACKUP_EXTENSION` | `".backup"` |

### `src/types/index.ts` — 主要な型

```typescript
interface WtbConfig {
  base_branch: string
  docker_compose_file: string
  copy_files: string[]
  link_files: string[]                       // copy_files より優先
  start_command?: string
  end_command?: string                       // セット時は Docker teardown を肩代わり
  env: { file: string[]; adjust: Record<string, string | number | null> }
}

interface WorktreeInfo { path; branch; head; locked?; prunable?; bare?; detached? }
interface EnrichedWorktreeInfo extends WorktreeInfo {
  shortHash; subject; ageRelative; ageTimestamp; dirty; enrichmentError?
}

interface WorktreePorts {
  path: string
  branch: string
  env: Record<string, string>                // env.adjust に列挙された key の現値
  compose: { file: string | null; services: Record<string, ComposeServicePorts> }
  endpoints: string[]                        // http://localhost:<host_port>
}

interface ContainerInfo { id; name; image; status; ports; volumes; networks }
interface ComposeConfig { version?; services: Record<string, ComposeService>; volumes?; networks? }
```

その他: `LsCommandOptions`, `PortsCommandOptions`, `InitClaudeOptions`, `ComposeService`, `VolumeInfo`, `EnvConfig`, `FileOperationOptions`, `ExecOptions`, `CommandOptions`, `CommandContext`。

### `src/core/git/`

```typescript
// repository.ts
isGitRepository(cwd?): boolean
getGitRoot(cwd?): string
getRepositoryContext(cwd?): { currentRoot; mainRoot; commonGitDir }
getMainWorktreeRoot(cwd?): string
acquireRepositoryLock(context, opts?): Promise<() => Promise<void>>
withRepositoryLock(context, operation, opts?): Promise<T>
getCurrentBranch(cwd?): string
branchExists(name, cwd?): boolean

// worktree.ts
listWorktrees(cwd?): WorktreeInfo[]                       // git worktree list --porcelain をパース
createWorktree(branch, path, opts?): void
removeWorktree(path, opts?): void
getWorktreePath(branch, cwd?): string | null

// commit-info.ts
enrichWorktree(wt: WorktreeInfo): Promise<EnrichedWorktreeInfo>   // ls -l 用
```

### `src/core/docker/`

```typescript
// client.ts
getRunningContainers(opts?): ContainerInfo[]              // docker ps をパース
getDockerVolumes(opts?): VolumeInfo[]
getWtbManagedVolumeNames(opts?): string[]                 // label=wtb.managed=true で正確に列挙
getUsedPorts(opts?): number[]                             // 稼働中コンテナの host port 一覧
isWtbContainer(c: ContainerInfo): boolean                 // 名前に "wtb" を含む or WTB_* env と一致

// compose.ts
readComposeFile(path, opts?): ComposeConfig
writeComposeFile(path, config, opts?): void
parsePortMapping(s): { hostPort; containerPort } | null   // "0.0.0.0:3000:80/tcp" などを解釈
adjustPortsInCompose(config, usedPorts): ComposeConfig    // 衝突しないよう host port を昇順割当
propagatePortsInComposeValues(config, portMap, …)         // env で付け替えた旧→新ポートを compose 値の default へ伝播
findComposeFile(dir): string | null
resolveComposeProjectName(config, workdir, env?): string  // volume 名解決用。COMPOSE_PROJECT_NAME > name: > basename
safeResolveComposeProjectName(file, workdir): string|null // 読めない compose でも throw しない安全版（remove/up/down のガード用）
sanitizeProjectSlug / uniqueProjectSlug / sanitizeContainerName
rewriteComposeIdentity(config, …): ComposeIdentityRewrite // name: / container_name: を worktree ごとに書き換え
composeStop/composeStart(file, project, cwd): void        // stop-then-copy 用（source スタックの一時停止/再開）
composeUp/composeDown(file, project, cwd): void           // wtb up / down と remove の teardown 用

// volume.ts — 名前付き Docker volume のクローン（データ自律性の中核）
resolveVolumeName(config, key, project): { name; external } | null
discoverCloneableVolumes(config, exclude[]): string[]     // non-external な named volume key 一覧
volumeExists(name) / getVolumeSize(name): number | null   // size は不明時 null（probe 失敗と空を区別）
getContainersUsingVolume(name): string[]
copyVolume(src, dst, opts)                                // clearTarget=true は atomic 上書き経路へ
copyVolumeWithRsync / copyVolumeWithCp                     // rsync 主、cp フォールバック
parseRsyncProgress(line)                                  // 進捗パース（純粋関数 / テスト対象）
repoVolumeLabel(mainRoot): string
inspectVolumeOwnership(name): { managed; repo?; project?; branch?; temp }
prepareTargetVolumeForCopy(name, ownership, opts)          // foreign/unmanaged data を fail-closed
readVolumeRecoveryRecords(commonGitDir/wtb/volume-recovery)
```

### `src/core/environment/processor.ts`

```typescript
parseEnvFile(path, opts?): ParsedEnvFile                  // {lines: EnvLine[], entries: EnvEntry[]}
copyAndAdjustEnvFile(src, dst, adjust, opts?, usedPorts?): number   // 戻り値 = 調整した件数
```

`ParsedEnvFile.lines` は `{ type: "entry"; key; value; comment? } | { type: "other"; content }` のユニオン。**並び順とコメント・空行が完全に保存**される。

### `src/core/config/`

```typescript
loadConfig(dir?): WtbConfig                               // 検索 → YAML パース → defaults とマージ → validate
findConfigFile(dir?): { path; exists }
mergeWithDefaults(partial): WtbConfig                     // ?? 演算子で falsy-safe マージ
validateConfig(config, configFile): void                  // warning は stderr、error は throw
normalizeRepositoryRelativePath(value, field): string
resolveRepositoryPath(root, value, opts?): string         // I/O 直前の containment/symlink 検査
validateConfiguredPaths(config): ConfigPathIssue[]
createDefaultConfig(path?): WtbConfig
```

設定 path は main repository root 相対に限定する。absolute / `..` / repository root / `.git` / list 内の normalized duplicate / nested link / link が他 write target の祖先、は CONFIG_ERROR。`.wtb/config.yaml` でも基準は `.wtb/` ではなく main root。

### `src/cli/utils/claude-skill-install.ts`

```typescript
resolveTemplateRoot(): string                             // src/ と dist/ どちらからでも templates/ を解決
resolveTargetDir(opts, cwd?): string                      // --user → ~/.claude/skills/wtb / 既定 → <gitRoot>/.claude/skills/wtb
installClaudeSkill(opts, cwd?): Promise<InstallResult>
```

### `src/utils/exec.ts`

```typescript
execSafeSync(file, args[], opts?): string                 // execFileSync ラッパー（shell 経由なし）
execGitSafe(args[], opts?): string                        // execSafeSync("git", args)
execDockerSafe(args[], opts?): string
executeLifecycleCommand(command, cwd): void               // start_command / end_command 用は /bin/sh 経由
```

---

## コマンドのライフサイクル

### `wtb create <branch>` — フェーズパイプライン

| Phase | 処理 | スキップ条件 |
| --- | --- | --- |
| 1. context/lock/検証 | `getRepositoryContext` で main/current/common Git dir を確定し、repository lock 下で既存 worktree 再チェック、パス/branch/`--seed` 検証 | — |
| 2. worktree 生成 | `git worktree add` (新規ブランチなら `-b <branch> <base_branch>`) | — |
| 3. copy_files | 各エントリを worktree にコピー（link_files に重複するものは除外） | `--no-copy` |
| 4. link_files | temp symlink → existing target 退避 → rename。失敗時は復元 | `--no-link` |
| 5. env 処理 | Docker + 全兄弟 env/Compose の shared reservation set から採番し atomic write | `--no-env` |
| 6. compose 調整 | target checkout 版を優先し、無ければ main 版。IPv4/IPv6 short と single-published long を調整し atomic write | `--no-docker` または `docker_compose_file` 未設定 |
| 7. data（clone / seed） | 既定: `setupVolumeCopy` で named volume を stop-then-copy クローン（in-use なら source スタックを stop→copy→restart、target 既存データは atomic 上書き）。`--seed` 時: 代わりに `volumes.seed_command` を worktree 内で実行（source volume に触れない） | `--no-volume-copy`（clone のみ）/ `--no-docker` / `docker_compose_file` 未設定 |
| 8. start_command | `/bin/sh` 経由で起動スクリプト実行（失敗しても worktree は残す） | `--no-start` または `start_command` 未設定 |

lock は worktree add から copy/link/env/Compose 採番まで保持し、volume clone/start 前に解放する。atomic `mkdir` で所有権を取り、最大 5 分待機。PID が死んで開始から 10 分超の lock だけ回収する。

missing optional copy/link は `setupWarnings`、実 I/O と copy/link/env/Compose/start failure は `setupFailures`。failure 時は worktree を残し成功バナーを出さず、既定 exit 0 / `--strict` exit 1。`create --json` の `ok` は setup failure も含み、source restart failure は常に exit 5。

### `wtb remove <branch>`

- main/locked target と破損 managed manifest は cleanup 前に拒否。dirty 検査のため解除した skip-worktree は、削除未完了の全経路で SHA 一致ファイルだけ復元する。
- `end_command` があれば automatic teardown は intentional skip。明示 `--no-docker` / `--no-end` も成功扱い。
- automatic teardown / end failure は通常 worktree を保持。`--force` のみ削除続行するが Docker failure exit 5 / end failure exit 1 と `ok:false` を保持。
- `--json` は hard error でも常に `{branch,path,removed,forced,composeDown,endCommand,cleanupErrors,ok}` を 1 object 出す。通常 failure は `removed:false`、forced partial は `removed:true,ok:false`。

### `wtb up [branch]` / `wtb down [branch]`

- worktree の Compose スタックを **worktree 自身の compose ファイルと project 名**で `docker compose up -d` / `down` する（`-f` / `-p` を常に明示）。shell-only `COMPOSE_PROJECT_NAME` は事前拒否し、stable `.env` / `name:` は sibling/source uniqueness を検証する。
- 対象は引数 branch、無ければ cwd を含む worktree。main worktree は拒否（source は wtb の管理対象外）。
- source と target の project 名を `safeResolveComposeProjectName` で比較し、同一なら hard-fail（remove の teardown ガードの hard-fail 版）。`down --remove-volumes` は `down -v`。`--json` 対応。

### `wtb reclone [branch]`

- 既存 worktree の **volume クローンフェーズだけ**を再実行する recovery コマンド（worktree は作り直さない）。`create` の `setupVolumeCopy` / `previewVolumeCopy` を再利用するため stop-then-copy / atomic overwrite / partial-failure surfacing をそのまま継承。
- 対象 worktree は引数 branch（無ければ cwd を含む worktree）。main worktree は source==target になるため拒否。`docker_compose_file` 未設定なら no-op。
- `--force-volume-copy` / `--no-stop` / `--dry-run` 対応。failed>0 でも exit 0 + 「NOT fully isolated」バナー（create と同契約）。

### `wtb prune [-y] [--discard-recovery] [--json]`

- main config の正確な Compose path から live owner を解決。新形式は rename/config 変更直後の誤削除を避けるため、`wtb.project` または `wtb.branch` のどちらかが live なら保持し、両方とも不一致のときだけ orphan。owner label 不在の legacy のみ project prefix fallback。
- recovery record が参照する temp は protected。通常 `--yes` でも削除せず、`--yes --discard-recovery` でだけ volume と record を破棄。
- config/Compose/worktree/recovery/Docker inquiry のどれかが失敗すれば、削除前に fail-closed。
- `--json` は `{ dryRun, candidates, protected, removed, failed }`。

### `wtb ls`

- `listWorktrees()` 取得後、`--long` 時のみ `Promise.all(worktrees.map(enrichWorktree))` で並列に commit info を取得。
- 出力切替: 既定 / `-l` / `--json` / `-p` (paths only)。レンダリングは `cli/utils/worktree-render.ts` の pure 関数で完結。

### `wtb ports`

- 既定はカレント worktree のみ。`--all` で全 worktree。
- 各 worktree について `gatherPortsForWorktree()`:
  1. `config.env.file` 内の `config.env.adjust` キーの現値を抽出
  2. compose ファイルを `readComposeFile` → 各サービスの `ports` を `parsePortMapping` で分解
  3. host_ports から `http://localhost:<port>` を生成
- 既定は JSON 出力（Claude Code から機械パース用）。`--pretty` でテーブル。

### `wtb path <branch>`

- ブランチ名から worktree の絶対パスを 1 行で stdout に出す primitive（`cd "$(wtb path feature/x)"` 用）。
- 見つからなければ利用可能な worktree 一覧を stderr に出して exit 1（stdout は script 出力用に汚さない）。

### `wtb init`

- コメント付き `wtb.yaml` テンプレートをリポジトリルートに生成。既存ファイルがあれば `--force` 無しはエラー。
- `base_branch` は `origin/HEAD` から自動検出（未設定なら `main` にフォールバック）。

### `wtb doctor`

- **静的 preflight**: repo の compose / env ファイルを `analyzeRelocatability` で解析し、worktree relocatability を壊す構成（固定 `name:`、`container_name` の衝突、リテラルなポート参照、override ファイル等）を finding として報告。
- 実際の設定（`compose.isolate_name` / `compose.container_name` / `env.port_propagation`）に合わせて finding を降格するため、create が自動で直すものは warning にならない。
- `--json` / `--strict`（warning/error があれば exit 1）。`create` も同じ解析を `runRelocatabilityPreflight` として実行し、warning/error のみ stderr に出す（exit code には影響しない）。

### `wtb init-claude`

- テンプレート探索: `import.meta.url` から `../../../templates/claude/skills/wtb/SKILL.md` を解決（src/ と dist/ どちらからでも同じ相対深度）。
- 配置先: `--user` で `~/.claude/skills/wtb/`、既定で `<gitRoot>/.claude/skills/wtb/`。
- 既存ファイルがある場合: `--force` 無しならスキップ。`--dry-run` は対象パスのみ出力。

### `wtb status`

- worktree 一覧（既定はカレントのみ、`-a` で全件）と各 worktree の compose / env ファイル検出。
- Docker 状態は `isWtbContainer()` フィルタを通したコンテナと、`name` に `wtb` または `worktree` を含むボリューム。`docker_compose_file` が未設定なら省略。
- `--json` で `{ worktrees, docker }` を 1 オブジェクトとして stdout に出力（`buildStatusJson`）。Docker 不在でも valid JSON（`docker.available=false`）。`ls --json` / `ports` と並ぶ機械可読系。

---

## 横断的な設計判断

### ポート衝突回避

env と Compose は repository lock 下で同じ `Set<number>` を共有する。集合は (1) Docker 公開 port、(2) main を含む全 sibling の configured env、(3) 全 sibling の正確な configured Compose、(4) 今回既割当、の union。採番枯渇時は予約済み port を返さず setup failure。

Compose は IPv4/IPv6 short syntax と numeric/string の単一 `published` long form を調整する。range、`network_mode: host` / `container:...` / variable は分離不能として throw し、main/兄弟の予約収集と `wtb up` でも同じ network-mode guard を適用する。

### worktree ごとの Compose identity 分離とポート伝播

- **`compose:` 設定ブロック**: 既定（`compose.isolate_name: true`）で create は worktree 側 compose の `name:` を worktree 固有の project slug に書き換える（`rewriteComposeIdentity`）。`compose.container_name:` は `suffix`（既定 — worktree suffix を付与）/ `strip`（削除して自動命名に委ねる）/ `keep`（触らない — 衝突リスクは doctor が警告）。
- **`env.port_propagation`**（既定 on）: `env.adjust` で付け替えた旧→新ポートを、`files` に列挙した他の env ファイルと、compose 内の変数 default（`${VAR:-3000}` の default 部のみ — `compose: true`）へ伝播する。compose の `ports:` エントリを直接書き換えるのは `adjustPortsInCompose` の責務であり、propagation は default 置換に限定される。
- **volume ラベル**: target は `wtb.managed=true`, `wtb.repo`, `wtb.project`, `wtb.branch`、stage はさらに `wtb.temp=true`。overwrite は owner 完全一致を要求し、foreign/unmanaged data は force でも拒否。空 unmanaged は unused 確認後のみ再作成。
- **overwrite recovery**: stage size は source byte 数と完全一致が必要。target clear 前に common Git dir の `wtb/volume-recovery` へ versioned record を atomic 保存し、成功後だけ削除。record 付き temp は prune protected。

### パスと atomic file I/O

- configured paths は repository-relative only。validation と実 I/O 直前の containment/symlink-ancestor 検査を二重化する。
- Compose/env/managed manifest/recovery record は同一 directory temp へ write + fsync + rename。既存 mode を保持する。
- managed manifest は versioned `{version, files}`。legacy flat map を読めるが、JSON/shape 破損は empty 扱いせず remove を fail-closed。

### `.env` 順序保存と削除

- `parseEnvFile` は 1 行ずつ `EnvLine` ユニオン（`entry` または `other`）にパースする。コメントと空行は `other` として原文保持。
- 削除指示（`adjust: { KEY: null }`）は **`Set<string>` に集めてから一括フィルタ**。`__DELETE__` のようなセンチネル値を使わないため、ユーザの env 値が文字列リテラル `__DELETE__` でも安全。
- 数値の調整は `findNextFreePort` を経由してポートを自動採番。文字列はそのまま置換、関数なら値変換。

### シェルインジェクション防止

- Git / Docker 呼び出しはすべて `execFileSync(cmd, args[], …)` 経由（`execGitSafe` / `execDockerSafe`）。引数配列なのでメタ文字解釈なし。
- 例外は `executeLifecycleCommand` のみで、ユーザ提供の `start_command` / `end_command` を `/bin/sh` 経由で実行（パイプ・シェバン等のサポートが必要なため）。エスケープはユーザ責務。

### Claude Code Skill の配信

- `templates/claude/skills/wtb/SKILL.md` は `package.json` の `files` に含まれ npm tarball に同梱。
- `resolveTemplateRoot()` は `import.meta.url` から templates ディレクトリを解決する設計で、**src/ と dist/ どちらに居ても同じ相対深度（3 段上）** で解決可能。
- 配置後の `SKILL.md` の YAML frontmatter `name: wtb` が Claude Code 側のスキル識別子として使われる。

---

## テスト戦略

| カテゴリ | 場所 | 件数 (現状) | 主な内容 |
| --- | --- | --- | --- |
| ユニット | `src/**/*.test.ts` | 140 件 / 13 ファイル | 純関数（renderer, parser, validator, port adjustment）と外部 IO のモック |
| E2E | `e2e/cli.test.ts` | 101 件 / 1 ファイル | CLI を子プロセス起動し、temp git repo に対して全コマンドを通す |
| ヘルパ | `src/test/helpers/` | — | `createWtbConfig`, `createTestContainer` など |
| フィクスチャ | `src/test/fixtures/`, `e2e/projects/` | 7 プロジェクト | basic / edge-cases / env-adjust / full-featured / link-files / missing-files / no-docker |

実行: `npm run test:unit` / `npm run test:e2e` / `npm run test:run` (両方)。`test` / `test:run` / `test:e2e` は npm pre-script で先に build し、E2E が stale `dist` を使わない。`test:ui` は対話用に独立。

ユニットテストは外部依存（`execSync`, `fs`, `yaml`）を `vi.mock` でモック。E2E テストはモックせず実 Git / 実ファイルシステムを使うが、Docker は条件付き（環境に Docker が無くても fall back する）。

---

## 配布

`package.json`:

```json
{
  "name": "@schemelisp/wtb",
  "bin": { "wtb": "dist/cli/index.js" },
  "files": ["dist", "templates", "README.md", "LICENSE"],
  "type": "module",
  "engines": { "node": ">=18" }
}
```

tarball に含まれるのは **`dist/`, `templates/`, `README.md`, `LICENSE`** のみ。`sample/` や `e2e/` は含まれない。

依存:

- ランタイム: `commander` (CLI), `fs-extra` (再帰コピー), `yaml` (parse/stringify)
- 開発: `typescript`, `vitest`, `@biomejs/biome`, `tsx`

---

## 既知の制約

- **ポート探索の上限**: `PORT_RANGE.SEARCH_LIMIT = 100`。ベースポートから 100 連続で空きが見つからない場合は警告と共に元ポートを返す（衝突する可能性あり）。100 ブランチ以上の同時稼働は想定外。
- **固定 `container_name:` の扱い**: v1.1.0 以降、既定（`compose.container_name: suffix`）では create が worktree ごとに `container_name` へ suffix を付けて書き換えるため衝突しない。`keep` を選ぶと旧来どおりグローバル名のまま worktree 間で衝突する（`wtb doctor` が警告）。`container_name` 未指定のサービスは Compose が `<project>-<service>-N` と自動命名する（`sample/docker-compose.yml` 参照）。`external: true` でない named volume は worktree ごとにクローンされ project スコープで分離される。
- **volume の atomic 上書きには最小の commit 窓がある**: Docker に volume rename が無いため、`--force-volume-copy` の上書きは「検証済み temp volume → target を clear+ローカル cp」で置換する。source 読み取り失敗で target が空になることはないが、commit 中（ローカル cp）に失敗すると target が中途半端になる。その場合 temp volume を残し復旧コマンドを表示する。SIGKILL 等で残った temp volume (`*__wtbtmp_*`) は `wtb prune` で掃除できる。
- **Windows 未対応**: `execFileSync` でのパス解釈と `/bin/sh` 依存により、現状は macOS / Linux 前提。
- **`end_command` セット時の Docker teardown**: ユーザ側で `docker compose down` を呼ぶ責務がある。設定し忘れるとコンテナが残る。
- **後方互換なし**: v1.0.1 の `wtb` は旧 `wturbo` 名の設定ファイル（`wturbo.yaml`）や env プレフィックス（`WTURBO_*`）を読まない。移行が必要。

---

## 拡張ポイント

- **新コマンド追加**: `src/cli/commands/<name>.ts` に `Command` を返す関数を実装し、`src/cli/index.ts` の `program.addCommand(...)` に登録。
- **新コア機能**: `src/core/<domain>/` 配下に純関数モジュールを作り、CLI から呼ぶ。型は `src/types/index.ts` に集約。
- **新 renderer**: `src/cli/utils/<command>-render.ts` に pure 関数として追加し、テストを `*.test.ts` で同居。

レンダリング・パース・バリデーションを **pure に保つ**（外部 IO を引数として注入する）ことで単体テストを高速かつ deterministic に維持する設計方針。
