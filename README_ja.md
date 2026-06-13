# wtb

**複数ブランチの開発環境を一瞬で切り替える**

Git worktree をベースにした CLI ツールで、ブランチごとに独立した作業ディレクトリを提供します。`.env` の自動コピー、ポート再マッピング、Docker Compose 環境の分離、**Docker volume の自動クローン (DB の中身を引き継いでブランチ環境を立ち上げ)**、`node_modules` のような重いディレクトリの symlink 化までを一括で面倒見ます。

[![npm version](https://img.shields.io/npm/v/@schemelisp/wtb.svg)](https://www.npmjs.com/package/@schemelisp/wtb)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

[English README](README.md)

---

## 目次

- [なぜ wtb？](#なぜ-wtb)
- [思想とスコープ](#思想とスコープ)
- [仕組み](#仕組み)
- [クイックスタート](#クイックスタート)
- [コマンド](#コマンド)
  - [`init`](#wtb-init)
  - [`create`](#wtb-create-branch)
  - [`remove`](#wtb-remove-branch)
  - [`reclone`](#wtb-reclone-branch)
  - [`prune`](#wtb-prune)
  - [`ls` / `list`](#wtb-ls-alias-list)
  - [`path`](#wtb-path-branch)
  - [`ports`](#wtb-ports-branch)
  - [`status`](#wtb-status)
  - [`doctor`](#wtb-doctor)
  - [`init-claude`](#wtb-init-claude)
- [設定ファイル](#設定ファイル)
- [環境変数の自動調整](#環境変数の自動調整)
- [Docker Compose 連携](#docker-compose-連携)
- [Volume の自動クローン](#volume-の自動クローン)
- [ライフサイクルスクリプト](#ライフサイクルスクリプト)
- [アーキテクチャ](#アーキテクチャ)
- [開発](#開発)
- [設計メモ](#設計メモ)
- [必要環境](#必要環境)
- [Claude Code 連携](#claude-code-連携)
- [トラブルシューティング](#トラブルシューティング)
- [FAQ](#faq)
- [ロードマップ](#ロードマップ)
- [Changelog](#changelog)
- [License](#license)

## なぜ wtb？

Git worktree は強力ですが、単独で使うには手間がかかります。新しい作業ディレクトリを作るたびに、gitignore されたファイルのコピー、依存関係の再インストール、ポート再割り当て、長く動いているサービスの再起動などが必要になります。wtb はこの「のり付け」処理を自動化し、それぞれのブランチがミニ環境のように振る舞えるようにします。

典型的なユースケース:

- 機能ブランチで作業中に緊急修正が降ってきた — 数秒で 2 つ目の作業ディレクトリを立ち上げる
- 複数の機能ブランチを並行してビルド/テスト/サーブし、ポート衝突を避けたい
- スタッシュ・リセット・dev サーバーの停止をせずに、PR レビュー用のクリーンなチェックアウトが欲しい
- `.env` やローカル設定、認証情報を新しい worktree に自動コピー(または値を調整)したい
- Docker Compose を使っていて、ブランチごとに別ポートでサービスを動かしたい

## 思想とスコープ

wtb は特定の働き方 — DB やバックエンドのコード変更を含む多数の変更を、完全な並列(変更ごとに独立した worktree)で進めるやり方 — のために作られています。

- **並列性こそが高速化の源。** vibe coding において、DB やバックエンドのコード変更を伴う変更を **まったくの並列**(変更ごとに 1 worktree)で行うことで、作業速度の高速化を見込めます。
- **各 worktree はコード的に完全自立。** 各 worktree でコードの状態を変更・動作させつつ、他から完全に独立した自立性を保ちます。
- **各 worktree はデータ的にも完全自立。** DB の状態も完全なコピーから始まるので、各 worktree で他に影響を与えず、マイグレーションなどを自由に記述できる自立性を保ちます。
- **コンフリクトは起きて当然 — それでよい。** この働き方ではコンフリクトが起きるのが当たり前であり、最適なコードはさまざまな要件の衝突のすえに生まれます。wtb はこれを **あえて解消しません**。
- **当面は Docker Compose のみ。** 現状サポートするのは Docker Compose とその YAML ファイル・env ファイルだけです。他のスタックは現段階ではスコープ外です。
- **coding agent のオーケストレーションは(まだ)非対応。** wtb は coding agent のオーケストレーションをしません。各 worktree に立ち上がった coding agent は、作業を完遂したらそこで終了したとみなすのがよく、追加の作業があれば人力で見に行くことを推奨します。むしろ、プルリクエストの作成まで一気にやらせてしまうことを推奨します。
- _作者は F1 で使われる V6 Hybrid PU が好きです。_

## 仕組み

```
project/                        ← メイン worktree（元のリポジトリ）
├── wtb.yaml
├── .env                        APP_PORT=3000
├── docker-compose.yml          3000:80
├── node_modules/
└── src/

worktree-feature-auth/          ← `wtb create feature/auth` で作成
├── .env                        APP_PORT=3001   (自動でずらされ衝突なし)
├── docker-compose.yml          3001:80         (自動でずらされる)
├── node_modules -> ../project/node_modules     (symlink、コピーではない)
└── src/                        (git worktree — 同じ .git を共有)
```

`wtb create <branch>` は以下のフェーズを順に実行します:

1. **Worktree** — `git worktree add` で `../worktree-<sanitized-branch>/`(または `-p <path>`)に作成。新規ブランチは `base_branch` を起点に切り出し(origin にだけ存在するブランチは `origin/<branch>` からローカルのトラッキングブランチを作成)。
2. **ファイルコピー** — `copy_files`(gitignore された設定や秘密鍵など)をコピー。`link_files` にも含まれるパスはここでスキップ。
3. **シンボリックリンク** — `link_files` のエントリをソースリポジトリへ symlink(既存のファイル/ディレクトリ/symlink は安全に置き換え)。
4. **環境変数ファイル** — `env.file` をコピーし、`env.adjust` が空でなければポート風の値を他 worktree とぶつからない次の空きポートまでずらす。
5. **Docker Compose** — `docker_compose_file` 設定があれば、稼働中コンテナを避けつつ host ポートを再マッピングして worktree に書き出し。
6. **Volume クローン** — Compose の `volumes:` セクションに定義された non-`external` な named volume を、新 worktree の project に自動コピー。これで例えば PostgreSQL の中身がそのまま新 worktree でも使える。**ソーススタックが稼働中(ライブ DB では通常そう)なら、wtb が自動で stop → コピー → restart する**ので破損なく手動操作ゼロでクローンできる。`--no-stop` で稼働中 volume を skip する旧挙動に、`--force-volume-copy` でライブコピーに切り替えられる。詳細は [Volume の自動クローン](#volume-の自動クローン)。
7. **Start command** — `start_command` 設定があれば、新しい worktree 内で `/bin/sh` 経由で実行。

`wtb remove <branch>` は逆順で動作: `docker compose down`(`--remove-volumes` で `down -v`、`end_command` 未設定時) → `end_command` → `git worktree remove`。

## クイックスタート

### 1. インストール

```bash
npm install -g @schemelisp/wtb
# または単発実行
npx @schemelisp/wtb create feature/awesome
```

### 2. リポジトリのルートに設定を生成する

```bash
wtb init          # コメント付きの wtb.yaml を生成(base_branch は origin/HEAD から検出)
```

生成されたファイルを編集します。最小構成の例:

```yaml
# wtb.yaml
base_branch: main

copy_files:
  - .env
  - .env.local

link_files:
  - node_modules

env:
  file:
    - .env
  adjust:
    APP_PORT: 1       # 次の空きポートに自動増加
    DB_PORT: 1
```

### 3. 使う

```bash
wtb create feature/awesome
cd ../worktree-feature-awesome
# ...作業...
wtb remove feature/awesome
```

何もせずプレビューだけ:

```bash
wtb create feature/awesome --dry-run
```

## コマンド

### `wtb init`

リポジトリのルートにコメント付きの `wtb.yaml` を生成します — 最速のセットアップ手段です。`base_branch` は `origin/HEAD` から検出されます(リモートのデフォルトブランチが未設定なら `main` にフォールバック)。

| オプション | 説明 |
|-----------|------|
| `-f, --force` | 既存の設定ファイルを上書き |

設定ファイルが既に存在する場合は exit `1` で失敗します(`--force` で上書き)。git リポジトリ外では exit `3`。

### `wtb create <branch>`

新しいworktreeを作成します。

```bash
wtb create feature/new-feature
wtb create bugfix/urgent-fix
```

**ブランチの解決順序:**

1. **ローカルブランチが存在する** — そのまま使用。
2. **origin にだけ存在する** — `base_branch` から新規ブランチを切って黙って shadow せず、ローカルのトラッキングブランチを作成します(`git worktree add -b <branch> --track origin/<branch>`。メッセージ: `ℹ️ Branch <branch> exists on origin — creating local tracking branch from origin/<branch>`)。
3. **完全に新規** — `base_branch` から作成。その前に `base_branch` が解決可能か検証し(`git rev-parse --verify <base>^{commit}` ベースなのでタグ/SHA/remote ref も有効)、解決できなければ exit `1` で失敗し `wtb.yaml` に `base_branch` を設定するよう案内します(デフォルトブランチが `master` のリポジトリなど)。

ブランチの worktree が既に存在する場合、`create` は exit `6` で失敗します — `--exists-ok` を渡すとパスを表示して exit `0` で成功します(冪等な「worktree の存在を保証する」用途)。

**処理内容:**
1. `git worktree add` でブランチ用の作業ディレクトリを作成（`base_branch` からブランチを作成）
2. `copy_files` で指定したファイルをコピー
3. `link_files` で指定したファイル/ディレクトリにsymlinkを作成（`copy_files` より優先）
4. `env.file` で指定した環境変数ファイルをコピー（`env.adjust` が設定されている場合はポート等を調整してコピー）
5. `docker_compose_file` が設定・存在する場合は worktree にコピーしてポート衝突を自動調整
6. `start_command` を実行（設定時のみ）

**オプション:**

| オプション | 説明 |
|-----------|------|
| `-p, --path <path>` | worktreeの作成場所を指定（デフォルト: 親ディレクトリに `worktree-<branch名>` で作成） |
| `--no-create-branch` | 既存のブランチを使用（新規作成しない） |
| `--no-docker` | Docker Compose のセットアップをスキップ — **volume クローンもスキップされる**(volume フェーズは Docker 前提)ため、worktree は空の volume で始まる |
| `--no-env` | 環境変数ファイルの処理をスキップ（`.env`のコピー/調整） |
| `--no-copy` | ファイルコピーをスキップ（`copy_files`） |
| `--no-link` | symlink作成をスキップ（`link_files`） |
| `--no-start` | `start_command` の実行をスキップ |
| `--no-volume-copy` | Docker volume の自動クローンをスキップ |
| `--force-volume-copy` | 稼働中コンテナや既存 target volume があってもクローンを試行（dev のみ・データ破損リスクあり） |
| `--no-stop` | クローン前にソース Compose スタックを自動 stop せず、稼働中 volume を skip する（旧挙動） |
| `--seed` | クローンの代わりに seed する: volume クローンフェーズをスキップし、新 worktree 内で `volumes.seed_command` を実行する。ソース volume に一切触れないためソーススタックは止めない。`volumes.seed_command` の設定が必須で、`--force-volume-copy` とは排他。詳細は [Volume の自動クローン](#volume-の自動クローン) |
| `--strict` | volume クローンまたは seed コマンドが 1 つでも失敗したら非ゼロ (`1`) で終了する(既定は exit `0` — worktree は作成済み)。データ分離の不完全さを検知したい CI / コーディングエージェント向け。詳細は [Volume の自動クローン](#volume-の自動クローン) |
| `--exists-ok` | ブランチの worktree が既に存在する場合、exit `6` で失敗する代わりにパスを表示して exit `0` |
| `--json` | 機械可読な JSON オブジェクトを stdout にちょうど 1 つ出力する。人間向けの進捗は stderr へ。下記参照 |
| `--dry-run` | 実際の変更を行わず、実行内容をプレビュー |

**使用例:**

```bash
# Docker操作なしでworktreeを作成（高速、Docker不要）
wtb create feature/quick-fix --no-docker

# スタートスクリプトを実行せずにworktreeを作成
wtb create feature/wip --no-start

# 最小限のworktreeを作成（git worktreeのみ、ファイル操作なし）
wtb create feature/minimal --no-docker --no-env --no-copy --no-link --no-start

# 実行内容をプレビュー
wtb create feature/test --dry-run

# パスを指定して作成
wtb create feature/auth -p /tmp/auth-worktree

# 既存のブランチを使用
wtb create release/v2.0 --no-create-branch
```

人間向けモードでは、適用した調整を 1 件ずつ表示します — env フェーズではキーごとのポート bump(`APP_PORT: 3000 → 3001`)、Compose フェーズではサービスごとの remap(`web: 3000 → 3001`)。最後の *Next steps* ブロックは、この worktree に割り当てられたポートを確認する `wtb ports --pretty` を提案します。

**JSON 出力(`--json`):** stdout に pretty-print された JSON オブジェクトをちょうど 1 つ出力し、人間向けの進捗はすべて stderr に流れます。

```json
{
  "branch": "feature/auth",
  "path": "/Users/me/worktree-feature-auth",
  "created": true,
  "existing": false,
  "createdBranch": true,
  "dryRun": false,
  "env": { "APP_PORT": { "from": "3000", "to": "3001" } },
  "composePorts": { "web": [{ "from": 3000, "to": 3001 }] },
  "volumes": { "cloned": ["db_data"], "skipped": [], "failed": [] },
  "sourceStack": { "stopped": true, "restarted": true },
  "seed": null,
  "startCommand": { "ran": true, "failed": false },
  "ok": true
}
```

- `volumes.skipped` の各要素は `{ name, reason }`、`volumes.failed` は `{ name, error }`。`seed` は `--seed` 使用時に `{ ran, failed }`、未使用なら `null`(`startCommand` も `start_command` 設定時に同じ形)。
- `sourceStack` は `{ stopped, restarted, restartError?, recoverCommand? }` — クローンのためにソーススタックを止めた場合に現れます。`restarted` が `false` のときは `restartError`/`recoverCommand` がソーススタックの復旧方法を示し、コマンドは `--strict` の有無に関わらず exit `5`(Docker エラー)で終了します。
- volume クローンまたは seed が失敗すると `ok` は `false`。`--strict --json` でもその失敗で exit `1` になります — JSON を書き切ってから exit code が設定されます。
- 既存 worktree に対する `--exists-ok` では `{ branch, path, created: false, existing: true, createdBranch: false, dryRun, ok: true }` に縮小されます。

### `wtb remove <branch>`

worktreeを削除します。

```bash
wtb remove feature/new-feature
```

**処理内容:**
1. `docker_compose_file` が worktree に存在する場合は `docker compose down` を実行（`end_command` が未設定の場合）
2. `end_command` を実行（設定時のみ）
3. `git worktree remove` でworktreeを削除

**オプション:**

| オプション | 説明 |
|-----------|------|
| `-f, --force` | dirty チェックをスキップし、`git worktree remove` に `--force` を渡して強制削除(未コミットの変更は失われる) |
| `--no-docker` | Docker Composeの停止をスキップ（`docker compose down`） |
| `--no-end` | `end_command` の実行をスキップ |
| `--remove-volumes` | この worktree の Docker volume も削除 (`docker compose down -v`)。teardown が省略されるケース（`--no-docker` 時、または `end_command` 設定時）では**効果なし**（wtb が警告を出す。`end_command` 側で volume を削除すること) |

`-f` なしの場合、未コミット/未追跡の変更がある worktree は exit `1` で即座に失敗します(`Worktree for '<branch>' has uncommitted or untracked changes; commit/stash them or pass -f to force removal`)。このチェックは Docker teardown や volume 削除の**前**に走るため、失敗が確定している削除がサービス停止や volume 削除だけ先に実行してしまうことはありません。

自動 teardown は設定された Compose ファイルを明示的に渡して実行します(`docker compose -f <docker_compose_file> down [-v]`)。`compose.dev.yml` のような非デフォルト名でも正しく停止されます。

**使用例:**

```bash
# Dockerサービスを停止せずに削除（Docker未起動時に便利）
wtb remove feature/old-branch --no-docker

# 強制削除、クリーンアップもスキップ
wtb remove feature/abandoned -f --no-end
```

### `wtb reclone [branch]`

既存 worktree の **volume クローンフェーズだけ**を再実行します。クローンが失敗/skip された(volume が空/古い)ときに、worktree を作り直さずに(=未コミットの作業を失わずに)データを復旧できます。デフォルトは現在の worktree、branch 指定で別の worktree を対象にできます。

| オプション | 説明 |
|-----------|------|
| `--force-volume-copy` | source 稼働中・target に既存データがあってもクローン(上書きは atomic) |
| `--no-stop` | source Compose スタックを自動 stop せず、稼働中 volume を skip |
| `--strict` | volume が 1 つでもクローン失敗したら非ゼロ (`1`) で終了(既定は exit `0`)。データ分離の不完全さを検知したい CI / コーディングエージェント向け |
| `--json` | 機械可読な JSON オブジェクトを stdout に 1 つ出力(`{ branch, path, dryRun, volumes: { cloned, skipped, failed }, ok }` — volume ごとの形は `create --json` と同じ)。人間向けの進捗は stderr へ |
| `--dry-run` | クローン対象をプレビューし、変更しない |

```bash
wtb reclone                       # 現在の worktree
wtb reclone feature/auth          # 特定の worktree
wtb reclone feature/auth --force-volume-copy   # 古い target データを上書き
```

`create` と同じ `N cloned, N skipped, N failed` サマリを出力します。既定では failure があっても exit `0` で、`⚠️  … data is NOT fully isolated` を明示します(解消して再実行。`--strict` を渡すと exit `1`)。`--json` では `ok: false` が失敗を示し、`--strict` でも JSON を書き切ってから exit `1` になります。main リポジトリ worktree は対象にできません(source と target が同一 project になるため)。`docker_compose_file` 未設定なら no-op(メッセージのみ)。再クローンではなく再 seed したい場合は worktree 内で `volumes.seed_command` を実行してください。

### `wtb prune`

**孤児になった wtb 管理 Docker volume** — もう存在しない worktree 用に wtb がクローンした volume(`wtb remove` はデフォルトで volume を残すため)— と、中断された `--force-volume-copy` 上書きの**残骸 temp volume** を削除します。create/remove を繰り返すと溜まるので、その掃除用です。`wtb.managed=true` ラベル付き volume のみが対象で、このリポジトリの**どの worktree にも属さない** volume だけを削除します。

| オプション | 説明 |
|-----------|------|
| `-y, --yes` | 実際に削除する。**指定しなければ dry-run**(候補の表示のみ) |
| `--json` | 機械可読出力: `{ dryRun, candidates, removed, failed }` — 各 candidate は `{ name, reason, inUse, inUseBy }` で、`inUseBy` はブロックしているコンテナ名の一覧。`removed`/`failed` は volume 名の配列 |

```bash
wtb prune            # 削除対象をプレビュー(安全・何も消さない)
wtb prune --yes      # 孤児 + 残骸 temp volume を削除
wtb prune --json     # スクリプト/agent 向けの機械可読プレビュー
```

安全策: **デフォルトは dry-run**(削除は `--yes` 必須)、コンテナ使用中の volume はスキップ、worktree の volume は Compose プロジェクト名の前方一致(`<project>_…`)で厳密判定するため稼働中 worktree のデータは消しません。live 判定は `git worktree list`(このリポジトリ)に基づきます。

`--yes` 指定時、volume の削除に 1 つでも失敗すると exit `5`(Docker エラー — 部分的な prune として扱うこと)になります。`--json` なしではエラーは stderr に `Error: Failed to remove N volume(s): <names>` として出ます。`--json` ありでは JSON ペイロード全体が stdout に書き出され(失敗した volume は `failed` に列挙)、その後に exit code が設定されるため JSON は壊れません。

### `wtb ls` (alias: `list`)

軽量でスクリプト向けのworktree一覧表示。Unixの`ls`に近い使い勝手です。Docker情報が不要で、worktreeだけを素早く確認したい場合に使います。

```bash
wtb ls
wtb list      # 同じ
```

**オプション:**

| オプション | 説明 |
|-----------|------|
| `-l, --long` | 長形式（短縮コミットハッシュ、経過時間、dirty状態、サブジェクト） |
| `--json` | 機械可読JSON出力（`-l` と組み合わせると拡張フィールドも追加） |
| `-p, --paths` | 絶対パスのみを1行ずつ出力（`$(wtb ls -p \| fzf)` 等の用途に便利） |

フラグは組み合わせではなく優先順位で解決されます: `-p` は `--json` と `-l` を上書きします(パスのみの出力が優先)。

**出力例:**

デフォルト（compact、gitコール1回）:
```
→ main            /Users/me/proj                          [main]
  feature/api     /Users/me/proj-worktrees/feature-api
  feature/ui      /Users/me/proj-worktrees/feature-ui     [locked]
  hotfix/crash    /Users/me/proj-worktrees/hotfix-crash   [prunable]
  (detached)      /Users/me/proj-worktrees/detached-xyz
```

長形式（`-l`、worktree毎に `git log`/`git status` を並列実行）:
```
  BRANCH          COMMIT   AGE        D  PATH                                   TAGS / SUBJECT
→ main            a1b2c3d  2h ago     *  /Users/me/proj                         [main] Add foo
  feature/api     9f8e7d6  3d ago        /Users/me/proj-worktrees/feature-api   WIP refactor
```
タグ: `[main]` メインリポジトリ、`[locked]` `git worktree lock` 済み、`[prunable]` ディレクトリ消失、`[bare]` ベアリポジトリ。先頭の `→` は現在の作業ディレクトリを含むworktreeを示します（detached HEADでも正しく判定）。

パスのみ（`-p`、シェル連携用）:
```bash
# 別worktreeにfzfで移動:
cd "$(wtb ls -p | fzf)"
```

ブランチ名が分かっているなら対話的なピッカーは不要です — [`wtb path`](#wtb-path-branch) が決定的に解決します: `cd "$(wtb path feature/x)"`。

JSON（`--json`）:
```bash
wtb ls --json | jq '.[] | select(.isMain == false) | .path'
```

### `wtb path <branch>`

`<branch>` を持つ worktree の絶対パスを出力します — 改行で終わる 1 行のみで、stdout には他に何も出ません。シェルパイプラインや coding agent 向けの決定的な primitive です:

```bash
cd "$(wtb path feature/x)"                    # worktree に直接移動
wtcd() { cd "$(wtb path "$1")"; }             # 便利なシェル関数
```

一致する worktree が無い場合は `Available worktrees:` の一覧を stderr に出して exit `1` で失敗します(stdout はパイプライン用にクリーンなまま)。git リポジトリ外では exit `3`。

### `wtb ports [branch]`

現 worktree・指定ブランチの worktree・全 worktree の `env.adjust` 調整済み値、Docker Compose の host/container ポート、`http://localhost:<port>` エンドポイント一覧を出力します。Claude Code の [skill](#claude-code-連携) から呼び出される想定ですが、シェルスクリプトからも使えます。

| オプション | 説明 |
|-----------|------|
| `-a, --all` | 全 worktree を配列で出力（デフォルトは現在の worktree 1 件をオブジェクトで）。branch 引数とは併用不可(exit `2`) |
| `--pretty` | JSON ではなく人間向けテーブル |
| `--json` | 一貫性のために受け付ける no-op — JSON が既にデフォルト出力。`--pretty` とは排他(exit `2`) |

```bash
wtb ports                  # 現在の worktree
wtb ports feature/x        # ブランチ指定(cd 不要)
wtb ports -a               # 全 worktree を JSON 配列で
```

未知のブランチを渡すと `Available worktrees:` の一覧を stderr に出して exit `1` になります。

`wtb ports` は Compose のポートマッピング中の `${VAR}` / `${VAR:-default}` 参照を **静的に解決** します — worktree の env ファイルを参照し、Docker も起動中スタックも不要です。`'${KONG_HTTP_PORT:-54321}:8000'` のようなマッピング(以前は空のエンドポイントになっていた)が具体的な host ポートに解決されます。優先順位: **worktree の env ファイルの値 > Compose のデフォルト > 未解決**。未解決の変数はスキップ(エンドポイントなし)され、その変数名を含む警告が stderr に出ます。既知の制限: ネストしたデフォルト(`${A:-${B}}`)、ポート範囲、IPv6 は解決しません。

出力スキーマと利用例は [Claude Code連携](#claude-code-連携) を参照。

### `wtb status`

現在のworktree一覧とDocker環境の状態を表示します。

```bash
wtb status
```

**オプション:**

| オプション | 説明 |
|-----------|------|
| `-a, --all` | 現在のブランチだけでなく、全てのworktreeを表示 |
| `--docker-only` | Docker関連の情報のみ表示 |
| `--json` | 機械可読な JSON(worktree + Docker 状態)を stdout に出力 — スクリプト / agent 向け |

`--json` は 1 つの構造化オブジェクト(`{ worktrees: [...], docker: {...} }`)を返し、Docker が止まっていても valid JSON のまま(`docker.available: false`)です。`docker.volumes.wtb` の各エントリには `labelled` boolean が付きます: `true` は `wtb.managed=true` ラベル付き(真のソース)、`false` はレガシーな `wtb`/`worktree` 名前ヒューリスティックでのみマッチしたもの — wtb 管理 volume として扱う前に `labelled` を確認してください。`wtb ls --json`、`wtb ports`(JSON がデフォルト)、`wtb create --json` / `wtb reclone --json` と合わせて、wtb の読み取りと変更操作の両方が機械可読になります。

出力例:
```
📁 Git Worktrees Status

→ main (main)
   📂 /Users/me/project
   🐳 Docker: docker-compose.yml
   📦 Services: 3
   🔧 Environment: .env, .env.local

  feature/auth
   📂 /Users/me/worktree-feature-auth
   🐳 Docker: docker-compose.yml
   📦 Services: 3
   🔧 Environment: .env, .env.local
```

### `wtb doctor`

静的なプリフライト — **Docker 不要**。worktree を作る *前* に、リポジトリの Compose / env ファイルを検査し、worktree 間で衝突しうる問題を洗い出します: 固定された Compose の project name や `container_name:`、`env.adjust` のポート bump に追従しないリテラルな公開ポート、ポートマッピング中の未解決 `${VAR}`、調整対象ポートを埋め込んだ env 値、シェルの `COMPOSE_PROJECT_NAME`(worktree 分離を無効化する)など。

| オプション | 説明 |
|-----------|------|
| `--json` | 機械可読な JSON オブジェクトをちょうど 1 つ stdout に出力 |
| `--strict` | `warning` か `error` の finding が 1 つでもあれば exit `1`(デフォルトは warning があっても exit `0`) |

```bash
wtb doctor                 # 人間向けレポート
wtb doctor --json | jq .   # 機械可読
wtb doctor --strict        # CI ステップをクリーンなレポートでゲートする
```

各 finding は `{ id, severity, message, suggestion }` で、`severity` は `info` / `warning` / `error`。finding id: `fixed-project-name`、`container-name`、`literal-env-port`、`literal-compose-port`、`unresolved-port-variable`、`compose-project-name-env`、`no-compose-file`。**該当する自動処理が有効なとき finding は `info` に格下げ** されます — project name / container name 系のチェックは identity rewrite(`compose.isolate_name`)、リテラルポートのチェックは port propagation(`env.port_propagation`)で、どちらもデフォルト ON。無効化していると `warning` になります。

**Exit code:** デフォルトは **warning があっても exit `0`**(agent/CI フレンドリー — JSON の `ok` と `summary` が結果を持つので、ラッパー側で判断できる)。`--strict` を渡すと warning か error があるとき exit `1`。`--json` はちょうど 1 つの JSON オブジェクト(`{ composeFile, findings, summary: { info, warning, error }, ok }`)を stdout に出します。

同じチェックは [`wtb create`](#wtb-create-branch)(`--dry-run` も含む)実行時に自動でも走ります: warning/error の finding は stderr にプリフライトとして出力(末尾に `Run 'wtb doctor' for details.`)されますが、**create の exit code は一切変えません**。

### `wtb init-claude`

同梱の Claude Code Skill をこのリポジトリ(またはグローバル)に展開します。詳しくは [Claude Code連携](#claude-code-連携) を参照。

| オプション | 説明 |
|-----------|------|
| `-f, --force` | 既存 `SKILL.md` を上書き |
| `--user` | リポジトリではなく `~/.claude/skills/wtb/` にインストール |
| `--dry-run` | 対象パスのみ出力し書き込まない |
| `--check` | インストール済み `SKILL.md` をこの CLI のバージョンと照合 — 最新なら exit `0`、未インストール/stamp なし/古い場合は exit `1`。`--user` に対応。何も書き込まない |

インストーラは frontmatter 直後に `<!-- wtb-skill-version: X.Y.Z -->` の stamp を埋め込みます。`--check`(および `--force` なしで既存ファイルがあったときの skip メッセージ)はこの stamp を CLI バージョンと比較するため、wtb をアップグレードした後の skill の陳腐化を機械的に検知できます — `wtb init-claude --force` で更新してください。

## 設定ファイル

以下のいずれかのパスに設定ファイルを配置します（優先順位順）:

- `wtb.yaml`
- `wtb.yml`
- `.wtb.yaml`
- `.wtb.yml`
- `.wtb/config.yaml`
- `.wtb/config.yml`

どれも見つからない場合でも wtb はデフォルト設定で動作します — stderr にデフォルトの内容(`base_branch: main`、`./.env` を無調整コピー、ポート remap なし)を明示した警告を出し、[`wtb init`](#wtb-init) での雛形生成を案内します。

### 基本設定

```yaml
base_branch: main
```

### ファイルコピー

gitignoreされているファイルや設定ファイルを新しいworktreeにコピー:

```yaml
copy_files:
  - .env
  - .env.local
  - .claude          # ディレクトリも可
  - config/local.json
```

### シンボリックリンク

重いディレクトリ（`node_modules` など）はコピーせず、元リポジトリを参照するsymlinkを作成:

```yaml
link_files:
  - node_modules
  - .cache
```

> 同じパスが `copy_files` と `link_files` の両方にある場合、`link_files` が優先されます。

### ライフサイクルスクリプト

worktree 作成時・削除時にスクリプトを実行:

```yaml
# 作成後に実行（依存関係のインストールなど）
start_command: ./scripts/setup.sh

# 削除前に実行（クリーンアップなど）
end_command: ./scripts/cleanup.sh
```

`start_command` と `end_command` は worktree のルートを `cwd` として `/bin/sh` 経由で実行されます。`start_command` は最初に worktree からの相対パスとして解決を試み(`./scripts/setup.sh` のような形)、ファイルが無ければシェルに文字列として渡されます(`npm install && npm run dev` も動く)。

スクリプトの失敗は **致命的ではありません** — wtb は警告を出して worktree をそのまま残すので、手で続きを完了できます。

### 環境変数の自動調整

worktree間のポート衝突を自動的に回避:

```yaml
env:
  file:
    - .env
    - .env.local
  adjust:
    APP_PORT: 1        # 元の値+1から空きポートを自動検索
    DB_PORT: 1         # 元の値+1から空きポートを自動検索
    API_KEY: "new-key" # 固定文字列で置換
    DEBUG_PORT: null    # 変数を削除
```

`adjust` フィールドは3種類の値に対応:
- **数値** (`1`): ポート型のマーカー。`元の値 + 1` から空きポートを検索し、他worktreeの`.env`や同一パス内の他キーと衝突しないポートに置換する。**対象キーがそのファイルに存在しない場合は何も追記せず警告を出す**（ずらす元のポートが無く、マーカー値 `1` をそのまま書くのは無意味なため）。
- **文字列** (`"new-key"`): 指定した文字列で値を置換。キーが存在しなければリテラルとして追記。
- **null**: 変数をファイルから削除（存在しなければ no-op）。

#### ポート伝播(`env.port_propagation`)

bump されたポートは、その変数だけでなく他の値にも埋め込まれていることがよくあります。`.env` には `API_EXTERNAL_URL=http://127.0.0.1:54321` のように埋め込まれ、Compose には `${VAR:-default}` のデフォルトや文字列のポートマッピングに現れます。**ポート伝播(デフォルト ON)は old → new のポート変更をそれらの箇所にも反映** し、リマップ後も worktree の設定全体が内部的に整合するようにします。

有効なとき、数値(PORT マーカー)の `env.adjust` キーを bump した後、old→new のポートを次へ伝播します:

1. **そのポートを埋め込んだ env ファイル中の他の値**(例: `API_EXTERNAL_URL` が `DB_PORT` の bump に追従)。
2. **コピーされた Compose ファイル** — `${VAR:-default}` のデフォルトと文字列のポート/environment 値。

```yaml
env:
  # boolean ショートハンド — 全体を有効化(デフォルト)/無効化:
  port_propagation: true        # または false
  # フルオブジェクト形式(デフォルト値):
  # port_propagation:
  #   enabled: true              # マスタースイッチ
  #   files: []                  # env.file 以外で伝播対象に追加するファイル
  #   compose: true              # Compose コピーの ${VAR:-default}/文字列ポートも書き換え
```

`files` は `env.file` 以外で伝播対象に加えるファイルを列挙します。伝播は **境界安全** です: 直前が `:` で直後が URL/リスト/クォートの境界であるポートだけを書き換え、裸の数値は決してマッチしません(`54321` の *中* の `5432` は安全)。`port_propagation: false` で機能全体を無効化できます。bump にどの値が追従するか・しないかは [`wtb doctor`](#wtb-doctor) で確認できます。

### Docker Compose 連携

`docker_compose_file` を設定すると、wtbが自動的に:
- Composeファイルを各worktreeにコピー
- 実行中コンテナとのポート衝突を回避してリマップ
- worktree削除前に `docker compose -f <docker_compose_file> down` を実行(設定したファイルを明示的に渡すので `compose.dev.yml` のような非デフォルト名でも正しく停止)

なお、コピーされる Compose ファイルはパースして再シリアライズされるため、YAML のコメント・アンカー・元の整形は保持されません(wtb が書き出すすべての Compose ファイルに当てはまります)。Docker が未インストール/デーモン停止中でも Compose ファイルはパース・書き出しされますが、避けるべき稼働中コンテナが無いため host ポートは元の値のままになります(警告が出ます)。

#### worktree ごとの identity 書き換え(`compose:`)

デフォルト(`compose.isolate_name: true`)では、wtb は worktree の Compose コピーを書き換えて、各 worktree が 1 つの Compose プロジェクトを共有するのではなく **それぞれ独自の** プロジェクトを持つようにします。これは、トップレベルの `name:` や `container_name:` をハードコードするスタック(例: Supabase CLI の出力)に対する修正です: これが無いと、2 回目の `wtb create` で作られるスタックは 1 つ目のコンテナ/volume にアタッチまたは上書きしてしまいます。書き換えは **デフォルト ON** で、worktree の compose ファイルをその場で書き換えます:

- **project name** — トップレベルの `name:` を `<original>-<branch-slug>` にする。
- **container name** — 各サービスの `container_name:` を `compose.container_name` に従って処理。

```yaml
# wtb.yaml
compose:
  isolate_name: true        # worktree ごとにトップレベル name: を書き換え(デフォルト)。false で無効化。
  container_name: suffix    # サービスの container_name: の扱い:
                            #   suffix — -<branch-slug> を付加(デフォルト)
                            #   strip  — 削除(Compose が一意名を自動生成)
                            #   keep   — そのまま(2 つ目の worktree の `up` が衝突する; wtb が警告)
```

`container_name: keep` のとき、wtb は固定 `container_name:` を持つサービスを名指しで警告します(2 つ目の worktree の `docker compose up` が衝突するため)。これらの問題は事前に `wtb doctor` で検出できます。

#### 書き換えたファイルと git `skip-worktree`

worktree の compose コピー(および調整/伝播された env ファイル)は **git 追跡** されていることがあります — `git worktree add` がブランチからチェックアウトするためです。wtb はそれらを worktree ごとにその場で書き換えるので、書き換えた追跡ファイルを git の **`skip-worktree`** に設定します。これにより worktree 固有の書き換えが (a) `git status` に出ない、(b) `wtb remove` の dirty チェックをブロックしない、(c) 誤ってブランチにコミットされない、ようになります。worktree 内でそのようなファイルの変更を意図的にコミットしたい場合は、先に `git update-index --no-skip-worktree <file>` を実行してください。

```yaml
docker_compose_file: ./docker-compose.yml
```

Docker連携を無効にするには空文字を設定するか、フィールドを省略:

```yaml
docker_compose_file: ""   # 明示的に無効化
# またはフィールド自体を省略
```

### フル設定例

```yaml
base_branch: main
docker_compose_file: ./docker-compose.yml

copy_files:
  - .env
  - .env.local
  - .secrets
  - config/

link_files:
  - node_modules
  - .cache

start_command: npm install && npm run db:migrate
end_command: docker compose down

env:
  file:
    - .env
    - .env.local
  adjust:
    APP_PORT: 1    # 元の値+1から空きポートを自動検索
    DB_PORT: 1
```

## 設定項目一覧

| 項目 | 型 | デフォルト | 説明 |
|------|------|-----------|------|
| `base_branch` | string | `"main"` | 新しいworktreeブランチのベースブランチ名 |
| `docker_compose_file` | string | `""` | Docker Composeファイルのパス（省略または空文字でDockerスキップ） |
| `copy_files` | string[] | `[]` | 新しいworktreeにコピーするファイル/ディレクトリ |
| `link_files` | string[] | `[]` | symlinkを作成するファイル/ディレクトリ（`copy_files` より優先） |
| `start_command` | string | — | worktree作成後に実行するコマンド |
| `end_command` | string | — | worktree削除前に実行するコマンド |
| `env.file` | string[] | `["./.env"]` | 処理する環境変数ファイルのリスト |
| `env.adjust` | object | `{}` | 調整設定（数値: 空きポート検索, 文字列: 置換, null: 削除） |
| `env.port_propagation` | bool / object | `true` | bump されたポートを他の env 値と Compose コピーに伝播。boolean ショートハンド、または `{ enabled, files, compose }`。[ポート伝播](#ポート伝播envport_propagation) 参照 |
| `compose.isolate_name` | bool | `true` | worktree のトップレベル Compose `name:` を `<original>-<branch-slug>` に書き換え。[Docker Compose 連携](#docker-compose-連携) 参照 |
| `compose.container_name` | enum | `"suffix"` | サービスの `container_name:` の扱い: `suffix` / `strip` / `keep`。[Docker Compose 連携](#docker-compose-連携) 参照 |
| `volumes.exclude` | string[] | `[]` | 自動クローンから**除外**する compose volume key 一覧。デフォルトでは Compose の named non-`external` volume をすべて自動クローンする |
| `volumes.seed_command` | string | — | `wtb create --seed` 指定時に、volume データのクローンの**代わりに**新 worktree 内(`/bin/sh`)で実行するコマンド。main のクローンではなく新規 seed された DB から worktree を始められる。詳細は [Volume の自動クローン](#volume-の自動クローン) |

### バリデーション

設定読み込み時に wtb は以下を検証します:

- **エラー** (exit code `4` で失敗): 型違反、`base_branch` 欠落/不正、`copy_files`/`link_files` が配列でない、`env.adjust` の値型違反 など。
- **警告** (stderr に出力、処理は続行): `docker_compose_file` / `env.file` で参照したパスがディスク上に存在しない場合。`env.adjust` のキーが POSIX env var 名として不正な場合(どの `.env` 行ともマッチしない — wtb が修正案を提示する)。

## Volume の自動クローン

Compose ファイルが remap された後、wtb は **Compose の `volumes:` セクションに定義された全ての named Docker volume をソースから新 worktree の project に自動コピー** します。これでメインで動かしていた DB / cache の中身がそのまま新 worktree でも使えて、`pg_dump | pg_restore` や seed スクリプトの再実行は不要になります。

動作:

1. wtb は Compose の `volumes:` キーを列挙します。
2. `external: true` のものは **対象外** (共有意図のため)。
3. ソース volume 名は `<source_project>_<key>` (もしくは `volumes.<key>.name` で明示されていればそれ)、ターゲットも同様に新 worktree の project name を使って解決。
4. **plan-then-stop-then-copy。** wtb は何かを止める **前に** volume ごとのクローン計画を全て算出し、実際に 1 つ以上の volume をクローンする場合に限ってソース Compose スタックを止めます(これにより、ソースを止めたのに何もクローンせず restart に失敗して dev 環境を落としたまま、という以前の問題を防ぎます)。クローン対象のソース volume を稼働中コンテナが使用していれば、wtb は **ソース Compose スタックを stop**(`docker compose stop` — コンテナ・ネットワーク・volume は保持)してからコピーし、**restart**(`docker compose start`、失敗時は `up -d` にフォールバック)します。restart は `finally` で実行され、さらに `SIGINT` にも結線されているため、コピーが途中で失敗しても・Ctrl-C で中断してもソースのサービスが落ちたまま放置されることはありません。**別の** Compose project が掴んでいる volume は何も止めずに skip され、source と target が同じ volume 名に解決される場合はクローンを拒否します(自己上書き防止)。`--no-stop` で stop せず稼働中 volume を skip(警告つき)、`--force-volume-copy` で stop せずライブコピー(破損リスクあり)に切り替えられます。なお `docker compose start` はプロジェクト内の停止中サービスを**すべて**起動するため、意図的に落としていたサービスがあればクローン後に再度停止してください。

   **restart に失敗した場合**(`docker compose start` と `up -d` フォールバックの両方がエラー)、`wtb create` / `wtb reclone` は **`--strict` 無しでも exit code `5`(Docker エラー)で終了** します — restart の失敗は稼働中のソース環境を壊れたまま残すため、ハードな失敗として扱います — そして手動で実行する復旧コマンドを出力します。
5. 各 volume について:
   - **ソーススタックを stop した場合**(または `--force-volume-copy`、もしくは何も稼働していない場合)はクローンします。
   - **`--no-stop` 指定かつ稼働中コンテナがソース volume を使用中** なら skip + 警告 (Postgres/MySQL/Redis などはライブコピーで破損する可能性があるため)。`docker compose stop` してから、`--no-stop` を外して、または `--force-volume-copy` で実行してください。
   - **ターゲット volume が既に中身を持っていれば** skip (二度走らせて上書きしないため)。`--force-volume-copy` で上書きできます。この上書きは **atomic** です: 新しいデータを一時 volume にステージングし、検証してから target を置換するため、コピーが途中で失敗しても target が空になることはありません。
   - それ以外は `instrumentisto/rsync-ssh` の使い捨てサイドカーコンテナで再帰コピー (rsync が無ければ Alpine の `cp -a` にフォールバック)。

wtb が作成する volume には必ず **`wtb.managed=true`** ラベルが付くため、project/パスの命名に依存せず自己識別できます。`wtb status` はこのラベルで wtb 管理 volume を正確に列挙し (カスタム `-p` パスでも)、`docker volume ls --filter label=wtb.managed=true` で自分でも一覧できます。

特定の volume を除外したい (例: 再生成可能なキャッシュ):

```yaml
# wtb.yaml
volumes:
  exclude:
    - cache_data
    - tmp_data
```

その実行回だけスキップしたいときは `wtb create <branch> --no-volume-copy`、ソーススタックを止めずに稼働中 volume を skip したいときは `--no-stop`、稼働中ソースを止めずに強制ライブコピーしたい (dev のみ・データ破損リスクあり) ときは `--force-volume-copy`。

volume ごとのサマリは `N cloned, N skipped, N failed` の形式で出力されます。いずれかの volume のクローンが **failed** になった場合、worktree 自体は作成されますが、最後のバナーが `🎉 Worktree created successfully!` から `⚠️  Worktree created, but N volume(s) FAILED to clone — this worktree's data is NOT fully isolated` に変わり、不完全な状態が明示されます。既定では終了コードは `0` のまま(worktree は存在するため)ですが、**`--strict`** を渡すとクローン(または `--seed`)失敗時に exit `1` になり、CI やコーディングエージェントがデータ分離の不完全さを検知できます。*skip* は意図的なものです — source 不在、稼働中 (in-use。`--no-stop` 時のほか、ソーススタック停止後も別の Compose project が同名 volume を掴んでいる場合にも起こる)、target に既存データ、の 3 ケース。external/`exclude` 指定の volume は集計前にクローン対象から外れるためサマリには現れません。*failure* はコピー自体がエラーになったことを意味します。

`wtb remove <branch>` はデフォルトでは clone した volume を削除しません(`docker compose down` のデフォルト挙動と整合)。`wtb remove <branch> --remove-volumes` で `docker compose down -v` 相当に切り替わり volume も削除されます。これは自動 teardown 経由で動くため、teardown が省略される場合(`--no-docker` 時、または `end_command` 設定時)は no-op になり警告が出ます(その場合は `end_command` 側で volume を削除してください)。こうして残った volume は時間とともに孤児として溜まるので、[`wtb prune`](#wtb-prune) でまとめて掃除できます(wtb が作る volume には `wtb.managed=true` ラベルが付きます)。

### クローンの代わりに seed する(`--seed`)

main のデータのコピーではなく、新 worktree に**新規 seed された**データベースが欲しいことがあります(クリーンなマイグレーション先、決定的なテストフィクスチャなど)。seed コマンドを設定して `--seed` を渡します:

```yaml
# wtb.yaml
volumes:
  seed_command: docker compose up -d db && npm run db:migrate && npm run db:seed
```

```bash
wtb create feature/clean-db --seed
```

`--seed` を付けると wtb は **volume クローンフェーズを完全にスキップ**し、新 worktree 内で `volumes.seed_command` を実行します(`/bin/sh`・`cwd` は worktree ルート・`start_command` と同じパス/シェル解決)。ライブのソース volume から一切読み取らないため、この経路は**ソーススタックを止めません** — メインのサービスは稼働したままです。データを「コピー」ではなく「新規構築」する、構造的にデータ自律な経路です。

注意:

- `--seed` は `volumes.seed_command` の設定が必須です。未設定なら worktree を作る前に exit `4` で失敗します。
- `--seed` と `--force-volume-copy` は排他です(片方は seed、もう片方は clone)。両方渡すと exit `1` で失敗します。
- seed コマンドが失敗した場合、worktree 自体は作成されますがバナーが `⚠️  Worktree created, but the seed command FAILED — this worktree's data is NOT ready` に変わります(終了コードは `0` のまま — 失敗クローンと同じ契約。`--strict` を渡すと exit `1` になる)。修正後に worktree 内で seed を再実行してください。

## アーキテクチャ

```
src/
├── cli/
│   ├── commands/      init, create, remove, reclone, prune, ls, path, ports, status, init-claude
│   ├── utils/         worktree/ports レンダラ、共通エラーラッパー、Claude Skill インストーラ
│   └── index.ts       commander の組み立て + グローバルエラーハンドラ
├── core/
│   ├── config/        YAML ローダ + バリデータ + デフォルトマージ
│   ├── git/           repository / worktree / commit-info ヘルパー
│   ├── docker/        `docker ps`、compose のパース・書き出し、ポート調整
│   └── environment/   .env パーサ(順序保存) + adjust + シリアライズ
├── utils/             安全な exec ヘルパ(execFileSync ラッパー)、エラー型
├── types/             公開型定義(WtbConfig, WorktreeInfo, …)
├── constants/         デフォルト値、コマンドテンプレート、正規表現、終了コード
└── index.ts           ライブラリエントリポイント
```

モジュール毎の API と設計の根拠は [ARCHITECTURE.md](ARCHITECTURE.md) を参照。

主要な設計判断:

- **git/docker にシェル注入の余地なし。** ユーザ入力由来の値(ブランチ名・パス)は `execFileSync` に配列で渡し、文字列に展開しないため、メタ文字でシェル注入されない。一部の固定的な `docker compose` 呼び出しは `execSync` を使うが、渡すのはハードコードされた定数のみ(ユーザ入力は含まない)。意図的にシェルを使うのはユーザ提供の `start_command` / `end_command` だけで、これは `/bin/sh` 経由で実行する。
- **`??` でデフォルトマージ。** 未定義フィールドはデフォルトに、明示的な空配列・空文字列は保存される。
- **順序保存 `.env` パーサ。** コメント、空行、行末コメントもラウンドトリップで保たれる。
- **`ls` は pure renderer。** `renderDefault`/`renderLong`/`renderPaths`/`renderJson` は単独でユニットテスト可能、コマンドモジュールはそれらを繋ぐだけ。
- **enrichment はベストエフォート。** `ls -l` は壊れた worktree でも他の行は出力する。失敗は JSON で `enrichmentError` として表面化。

終了コード(`src/constants/index.ts`):

| コード | 意味 |
|------|---------|
| `0` | 成功 |
| `1` | 一般エラー |
| `2` | CLI 引数エラー — 引数不足、未知のオプション/コマンド、不正/過剰な引数、排他オプションの併用(例: `wtb ports --json --pretty`、branch 引数と `--all` の併用)。`--help`/`--version` は exit `0` のまま |
| `3` | git リポジトリ外 |
| `4` | 設定エラー(設定ファイルのパース失敗・バリデーション失敗) |
| `5` | Docker エラー — `wtb prune --yes` で volume 削除に失敗したとき(部分的な prune)、および `wtb create` / `wtb reclone` でクローンのためにソース Compose スタックを止めたものの **restart できなかった**とき(`docker compose start` と `up -d` フォールバックの両方が失敗 — これは `--strict` 無しでも exit `5`。ソース環境が壊れたまま残るため。復旧コマンドが出力される)。それ以外の Docker の問題は従来どおり graceful に degrade する(警告して継続)か、`1` として表面化する |
| `6` | worktree が既に存在 — 既に worktree を持つブランチへの `wtb create`(`--exists-ok` なし) |
| `130` / `143` | SIGINT (Ctrl-C) / SIGTERM による中断。中断扱いにすること — 中断された `create` は途中状態の可能性がある |

## 開発

```bash
git clone https://github.com/origamium/wtb.git
cd wtb
npm install

npm run dev                    # tsx でソースから直接実行
npm run build                  # tsc → dist/
npm start                      # ビルド済み CLI を実行

npm run test                   # vitest watch
npm run test:run               # vitest 1 回
npm run test:unit              # ユニットテスト(src/)
npm run test:e2e               # E2E(test-repos/ 配下に実 git repo を作る)
npm run test:integration       # 実 Docker での volume クローン検証(Docker 無しなら skip)
npm run test:ui                # vitest UI

npm run typecheck              # tsc --noEmit
npm run lint                   # biome lint
npm run format                 # biome format --write
npm run check                  # biome check --write (lint + format)
```

E2E テスト(`e2e/`)は一時 git リポジトリを作ってビルド済み CLI を実行します。`sample/` には Next.js + Postgres ベースの動作するプレイグラウンドがあり、実際の `wtb.yaml` / `.env` / `docker-compose.yml` が同梱されています。

より幅広い構成 — フルスタック Compose・最小 Compose・seed/exclude/external volume・Docker なしの Node プロジェクト・最小構成 — は [`examples/`](examples/) を参照してください。各ディレクトリが自己完結したプロジェクトで、`examples/try.sh <example> [branch] [--real]` が使い捨ての git リポジトリ上で実際の CLI を実行します(既定は dry-run):

```bash
examples/try.sh                                   # 一覧を表示
examples/try.sh minimal                           # 実行計画をプレビュー
examples/try.sh compose-minimal feature/db --real # 実行(DB volume をクローン)
```

## 設計メモ

- **大きなツリーは copy より symlink。** `node_modules`、`.cache`、`.next/cache` は基本的に `link_files` 行き。1 つのソース、ディスク重複ゼロ、即座の worktree 作成。トレードオフ: ある worktree でネイティブモジュールを別プラットフォーム向けに再ビルドすると他にも波及する — そういうものは `copy_files` で。
- **ブランチ名のサニタイズ。** `/` はデフォルトパスでは `-` に置換: `feature/auth` → `worktree-feature-auth`。完全制御したいときは `-p <path>`。
- **Docker は全フェーズでオプション。** `docker_compose_file` を省略、Docker 未インストール、`--no-docker` のいずれでも wtb は優雅に degrade し、Docker 関連の出力は Docker が到達可能なときだけ出る。
- **`wtb ls` vs `wtb status`。** `ls` は高速・スクリプト用途(デフォルト形式は git 呼び出し 1 回)。`status` は人間向けで Docker コンテキスト含む。スクリプトでは `ls -l --json` を推奨。
- **dry-run は嘘をつかない。** `--dry-run` は全フェーズを歩いて *実行されたら何が起こるか* を表示する。スキップ対象の不在ファイルも報告する。

## 必要環境

- Node.js 18+
- Git
- Docker（オプション — `docker_compose_file` を設定した場合のみ必要）

## Claude Code 連携

wtb には [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) が同梱されています。skill を入れると Claude Code のエージェントが自動で wtb CLI を呼び出し、「このworktreeのポートは？」「feature/auth のworktree作って」といった依頼に直接応えられるようになります。

### リポジトリに 1 回だけインストール

```bash
wtb init-claude                          # .claude/skills/wtb/SKILL.md を配置
git add .claude/skills/wtb
git commit -m "chore: install wtb Claude Code skill"
```

`.claude/skills/` は通常の git 管理ディレクトリなので、`git worktree add` や `wtb create` で作ったすべての worktree に自動で伝播します。worktree ごとの仕込みは不要です。

グローバル配置を選ぶ場合:

```bash
wtb init-claude --user                   # ~/.claude/skills/wtb/SKILL.md
```

フラグ: `-f, --force`(上書き)、`--user`(グローバル)、`--dry-run`(対象パスのみ確認)、`--check`(インストール済み skill を CLI バージョンと照合。何も書き込まない)。

インストールされた `SKILL.md` には `<!-- wtb-skill-version: X.Y.Z -->` の stamp が入るので、wtb のアップグレード後は `wtb init-claude --check`(最新なら exit `0`、未インストール/stamp なし/古い場合は `1`)で確認し、`wtb init-claude --force` で更新できます。

### データソース: `wtb ports`

Skill は `wtb ports` を呼び出して結果を読み取ります(JSON がデフォルト出力 — `--json` は一貫性のための no-op として受け付けられ、`--pretty` とは排他です)。シェルから直接使うこともできます:

```bash
wtb ports                                # 現 worktree を JSON オブジェクトで
wtb ports feature/auth                   # ブランチ指定で特定の worktree を
wtb ports -a                             # 全 worktree を JSON 配列で(エイリアス: --all)
wtb ports --pretty                       # 人間向けテーブル
```

出力スキーマ:

```json
{
  "path": "/Users/me/worktree-feature-auth",
  "branch": "feature/auth",
  "env": { "APP_PORT": "3001", "DB_PORT": "5433" },
  "compose": {
    "file": "docker-compose.yml",
    "services": {
      "web": { "host_ports": [3001], "container_ports": [80] },
      "db":  { "host_ports": [5433], "container_ports": [5432] }
    }
  },
  "endpoints": ["http://localhost:3001", "http://localhost:5433"]
}
```

ポイント:

- `env` には `env.adjust` に登録した key のみが入る。`.env` 内の他の値(API キー等のシークレット)は**漏れない**。
- `compose.services` は worktree のコピー済み Compose ファイルから読むので、**リマップ後のポート値**が得られる。
- `endpoints` は compose の host ポートから `http://localhost:<port>` を組み立てる簡易一覧。
- `wtb ports` は Compose YAML をディスクから読むだけで Docker を呼ばないため、Docker の有無で出力は変わらない。`compose.services` が `{}` になるのは compose ファイルが見つからない/パースできない場合のみ(警告は stderr)。stdout は常に有効な JSON。

### Claude が何をできるようになるか

Skill インストール後は、次のような依頼が自然に通ります:

| 発言 | Claude の挙動 |
|-----|---------------|
| 「ここの API のポート教えて」 | `wtb ports` を実行(JSON がデフォルト)→ 該当ポートを返答 |
| 「worktree 一覧見せて」 | `wtb ls -l` |
| 「feature/x の worktree に移動して」 | `cd "$(wtb path feature/x)"` — ブランチ → パスの決定的な解決 |
| 「このリポジトリに wtb をセットアップして」 | `wtb init` → コメント付き `wtb.yaml` を生成 |
| 「feature/login の worktree 作って」 | `wtb create feature/login`(破壊的変更は事前確認) |
| 「feature/old 片付けて」 | `wtb ls -l` で対象表示 → 確認 → `wtb remove feature/old` |
| 「この worktree の DB が空/クローン失敗した」 | `wtb reclone` → volume クローンフェーズだけ再実行(worktree は作り直さない) |
| 「この worktree で実際に何が動いてる?」 | `wtb status --json` → コンテナ/volume を構造化データで取得 |

Skill の `description` は `wtb.yaml` を含むリポジトリで自動発火するので、手動で呼び出す必要はほぼありません。

## トラブルシューティング

### "Not in a git repository"

Gitリポジトリ内からwtbを実行してください。ツールはGitルートを自動検出します。

### ポートの衝突

ポート調整が期待通りに動作しない場合、wtbは以下をスキャンしています:
1. 他のworktreeの`.env`ファイルで使用中のポート
2. 実行中のDockerコンテナが占有しているポート

`wtb status -a` で各worktreeに割り当てられているポートを確認できます。

2 つの worktree のスタックが分離されずに衝突する場合、よくある原因は固定された Compose の `name:` / `container_name:`、または `env.adjust` で bump される変数経由ではなくリテラルに公開されたポートです。[`wtb doctor`](#wtb-doctor) を実行してください — まさにこれらの relocatability の問題を指摘し、どの設定キー(`compose.isolate_name`、`env.port_propagation`)が各問題を処理するか教えてくれます。

### Dockerが利用できない

Dockerがインストールされていない、またはデーモンが起動していない場合、wtbはDocker操作を優雅にスキップします。`--no-docker` を使うとDocker関連の警告を完全に抑制できます。

### Worktreeが既に存在する (exit 6)

ブランチが既にworktreeとして存在する場合は exit `6` で失敗します。`wtb ls` で既存のworktreeの場所を確認し、`wtb remove` で古いものを先に削除してください — そのまま再利用してよければ `wtb create` に `--exists-ok` を渡します(パスを表示して exit `0`)。

## FAQ

**`git worktree add` と何が違いますか？**
wtb は内部で `git worktree add` を使い、その上に git 単体ではカバーできない処理を載せています: gitignore された設定ファイルのコピー、symlink、env-var の再マッピング、Compose ポート調整、ライフサイクルスクリプト。

**Docker は必須ですか？**
いいえ。`docker_compose_file` を空にする(または省略する)と Docker フェーズは丸ごとスキップされます。コピー・symlink・env 調整・ライフサイクルスクリプトはそれぞれ独立して動きます。

**`.git` ディレクトリはどうなりますか？**
触りません。Git 標準の worktree 機能で同じ `.git` を共有するため、ディスク使用量はほぼ平坦です。

**CI で使えますか？**
使えます — ただしライフサイクルスクリプト・Docker 連携・ポート再マッピングは主に開発機向けの便利機能です。CI では `wtb create <branch> --no-docker --no-start --no-link` でクリーンな分離チェックアウトが高速に得られます。

**「wtb」の由来は？**
"worktree turbo" の略 — git worktree に環境管理のターボを付けた、という意味です。

## ロードマップ

以下は **今後の予定であり、まだ実装されていません**。意図する方向性を記録するために記載しています。

- _現在リストにある項目はありません — 予定していた項目はすべて実装済みです(下記参照)。次に欲しい機能があれば issue を立ててください。_

最近実装済み(このリストにあった項目):

- **コピーの代わりに seed(オプション)。** ✅ `wtb create --seed` は volume データのクローンではなく、新 worktree 内で `volumes.seed_command` を実行します。main のクローンではなく新規に seed した DB が欲しいときに。稼働中 volume からのコピーが発生しないため、この経路では stop しません。詳細は [Volume の自動クローン → クローンの代わりに seed する](#クローンの代わりに-seed-する--seed)。
- **DB の完全性のための stop-then-copy。** ✅ `create` は稼働中のソース Compose スタックを自動で stop してから volume をクローンし、その後 restart します(クラッシュセーフ)。稼働中のライブ DB も手動操作ゼロでクローンできます。`--no-stop` で従来挙動にできます。

## Changelog

リリースノートは [CHANGELOG.md](CHANGELOG.md) を参照。

## License

[MIT](LICENSE) © ONOUE Origami
