# Configuration bootstrap

Patch implements the staged startup discovery needed before full configuration
resolution. The behavior is based on aider's
[`main`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L451-L504),
[`load_dotenv_files`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L361-L384),
and
[`generate_search_path_list`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L189-L210)
at the pinned revision. `src/config/bootstrap.ts` records the same attribution.

## Startup sequence

`bootstrapConfiguration`:

1. parses bootstrap controls from command-line arguments and the supplied
   environment;
2. asks the installed Git CLI for a provisional repository root;
3. searches for `.patch.conf.yml` in the home, repository, and working
   directories, followed by an explicit config path;
4. searches for `.env` in the same low-to-high order and loads an explicit env
   file last;
5. performs the final strict argument parse using the loaded `PATCH_*` values;
6. discovers the repository owning explicit file arguments; and
7. reruns the bootstrap once from the original environment if that true root
   differs from the provisional root.

The rerun prevents dotenv values from the incorrectly guessed repository from
leaking into the corrected result. Search paths are deduplicated, including
when the working directory is the repository root. Files from multiple Git
repositories are rejected rather than selecting an ambiguous root. Missing
file arguments use their nearest existing parent, so a planned new file can
still identify its repository.

`--no-git` disables later repository operations and true-root correction. It
does not remove the provisional repository from config and dotenv discovery,
matching aider's startup order.

The production CLI passes the staged subset into
`ConcreteApplicationService`. Interface controls such as history paths,
multiline, notifications, watch, and web remain Commander-only and cannot be
set through YAML or `PATCH_*`; configuration parity is therefore partial.

## Current controls

The bootstrap parser recognizes `--config`/`-c`, `--env-file`, `--encoding`,
`--git`/`--no-git`, `--model`, `--lint-cmd`, `--test-cmd`, `--edit-format`,
repeated `--file`, repeated `--read-only`, and positional editable paths.
The executable Commander surface exposes `--no-git`, not a positive `--git`
flag. Environment equivalents for these controls are `PATCH_CONFIG`,
`PATCH_ENV_FILE`, `PATCH_ENCODING`, `PATCH_GIT`, `PATCH_MODEL`,
`PATCH_EDIT_FORMAT`, `PATCH_LINT_CMD`, and `PATCH_TEST_CMD`.

Commit policy also participates in every bootstrap stage: `git-commit-verify`,
`generate-commit-messages`, `commit-author-name`, `commit-committer-name`, and
`commit-co-author`. CLI flags use the same names prefixed by `--`; environment
names use `PATCH_` plus the uppercase key with underscores. Both booleans
default to false and have explicit `--no-…` overrides; omitted Commander flags
do not override YAML or environment values. Identity strings are bounded and
reject controls without echoing the rejected value. See
[production commit policy](git-repository.md#production-commit-policy) for
attribution scope, provider-cost opt-in, and hook authorization/recovery limits.

Lint and test commands may also be set as `lint-cmd` and `test-cmd` in YAML.
Both are optional and have no built-in default: if a user does not configure a
command, Patch does not inspect package files or infer an npm, yarn, pnpm, or
bun invocation for the target repository.

YAML configuration files are validated and merged in this order:

1. built-in defaults;
2. home config;
3. repository config;
4. working-directory config; and
5. an explicit config file.

Process environment values override YAML. Dotenv files are then loaded in
search order with later values overriding both earlier dotenv files and the
initial environment, as aider does with `override=True`. Command-line values
have final precedence. The returned environment is an isolated copy for later
provider resolution; callers must never log it because it can contain secrets.
Neither the caller's environment object nor `process.env` is mutated.

`scripts/package-smoke.mjs` proves this production path after `npm pack` and a
clean install. It invokes the installed `patch` bin four times and observes safe
`/settings` fields: explicit YAML alone, process environment over YAML, explicit
dotenv over the initial environment, and CLI over dotenv. Each run uses only a
placeholder credential, stops without a provider turn, and asserts an unrelated
environment secret is absent from output. This complements the broader
in-process bootstrap matrix; it does not claim unsupported configuration keys.

Patch intentionally uses `.patch.conf.yml` and `PATCH_*` rather than Aider's
names. A model must be selected explicitly even when a provider credential is
present. OAuth/default-model onboarding, line-ending policy, model resource/
alias files, secondary roles, custom provider endpoints/timeouts, and most
Aider startup one-shots are not executable controls.

The executable uses this bootstrap before opening input. Missing models,
credentials, unsupported providers/edit modes, mixed repositories, and unsafe
or conflicting file selections fail before a provider turn. Default Git-enabled
startup requires an existing worktree and is refused with a message naming
`--no-git` when there is none. Directories and repository-relative globs passed
to positional files, `--file`, `--read-only`, `/add`, or `/read-only` expand to
contained files. Expansion skips symbolic links and `.git`, filters ignored
files, and is bounded to 200 selected files and 20,000 visited directory entries.
Empty matches and absolute globs fail explicitly. A literal path that does not
exist yet is still selectable, because a turn may create it. An exact existing
file or directory wins before glob interpretation, so a name such as
`[ab].txt` stays literal even beside `a.txt` and `b.txt`. See [slash
commands](commands.md) for shared selection semantics.
