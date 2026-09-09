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

## Current controls

The bootstrap recognizes `--config`/`-c`, `--env-file`, `--encoding`,
`--git`/`--no-git`, `--model`, repeated `--file`, and positional file paths.
Their environment equivalents use the Patch namespace: `PATCH_CONFIG`,
`PATCH_ENV_FILE`, `PATCH_ENCODING`, `PATCH_GIT`, and `PATCH_MODEL`.

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

Patch intentionally uses `.patch.conf.yml` and `PATCH_*` rather than aider's
names. It does not search aider's OAuth key file because Patch does not yet have
an OAuth feature. Patch currently validates only bootstrap keys; later feature
tasks will extend the strict YAML schema alongside their CLI controls.

The executable remains help-only while the session runtime is under
construction, so this module is currently exercised through its public API and
integration tests rather than a live provider flow.
