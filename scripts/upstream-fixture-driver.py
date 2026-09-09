"""Export deterministic behavior fixtures from a pinned external aider checkout."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def run_git(checkout, *arguments):
    return subprocess.run(
        ["git", *arguments],
        cwd=checkout,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def export_config_precedence(get_parser):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        configs = []
        for name in ("home", "repo", "cwd"):
            path = root / f"{name}.yml"
            path.write_text(f"model: {name}-model\n", encoding="utf-8")
            configs.append(str(path))

        old_model = os.environ.pop("AIDER_MODEL", None)
        try:
            config_value = get_parser(configs, None).parse_args([]).model
            os.environ["AIDER_MODEL"] = "environment-model"
            environment_value = get_parser(configs, None).parse_args([]).model
            cli_value = get_parser(configs, None).parse_args(
                ["--model", "cli-model"]
            ).model
        finally:
            if old_model is None:
                os.environ.pop("AIDER_MODEL", None)
            else:
                os.environ["AIDER_MODEL"] = old_model

    return {
        "configFiles": config_value,
        "environment": environment_value,
        "cli": cli_value,
    }


def export_chat_chunks(ChatChunks):
    names = (
        "system",
        "examples",
        "done",
        "repo",
        "readonly_files",
        "chat_files",
        "cur",
        "reminder",
    )
    chunks = ChatChunks(
        **{name: [{"role": "user", "content": name}] for name in names}
    )
    order = [message["content"] for message in chunks.all_messages()]
    chunks.add_cache_control_headers()

    return {
        "order": order,
        "withCacheHeaders": chunks.all_messages(),
        "cacheable": chunks.cacheable_messages(),
    }


def capture_error(operation):
    try:
        operation()
    except ValueError as error:
        return str(error)
    raise AssertionError("Expected upstream operation to raise ValueError")


def export_search_replace(editblock):
    response = """Here is the change:

```text
example.txt
<<<<<<< SEARCH
old value
=======
new value
>>>>>>> REPLACE
```

```sh
npm test
```
"""
    missing_filename = """<<<<<<< SEARCH
old value
=======
new value
>>>>>>> REPLACE
"""

    return {
        "parsed": list(editblock.find_original_update_blocks(response)),
        "missingFilenameError": capture_error(
            lambda: list(editblock.find_original_update_blocks(missing_filename))
        ),
        "replacements": {
            "exact": editblock.replace_most_similar_chunk(
                "before\nold value\nafter\n", "old value\n", "new value\n"
            ),
            "missingLeadingWhitespace": editblock.replace_most_similar_chunk(
                "    first\n    second\n        nested\n",
                "second\n    nested\n",
                "changed\n    updated\n",
            ),
            "ellipsis": editblock.replace_most_similar_chunk(
                "start\nkeep one\nmiddle\nkeep two\nend\n",
                "start\n...\nend\n",
                "new start\n...\nnew end\n",
            ),
        },
    }


def export_git_diff(InputOutput, GitRepo):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)

        def git(*arguments):
            return subprocess.run(
                ["git", *arguments],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            )

        git("init", "--quiet")
        git("config", "user.name", "Fixture User")
        git("config", "user.email", "fixture@example.com")
        git("config", "commit.gpgsign", "false")
        (root / "staged.txt").write_text("base staged\n", encoding="utf-8")
        (root / "working.txt").write_text("base working\n", encoding="utf-8")
        git("add", ".")
        git("commit", "--quiet", "-m", "initial")

        (root / "staged.txt").write_text("staged change\n", encoding="utf-8")
        git("add", "staged.txt")
        (root / "working.txt").write_text("working change\n", encoding="utf-8")

        repository = GitRepo(
            InputOutput(pretty=False, fancy_input=False), None, directory
        )
        return repository.get_diffs()


def export_repo_map(InputOutput, Model, RepoMap):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        definitions = root / "definitions.py"
        usage = root / "usage.py"
        definitions.write_text(
            'def greet(name):\n    return f"Hello {name}"\n', encoding="utf-8"
        )
        usage.write_text(
            'from definitions import greet\n\nprint(greet("Ada"))\n', encoding="utf-8"
        )
        repository_map = RepoMap(
            map_tokens=512,
            root=directory,
            main_model=Model("gpt-3.5-turbo"),
            io=InputOutput(pretty=False, fancy_input=False),
            refresh="always",
        )
        return repository_map.get_repo_map([], [str(definitions), str(usage)])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--aider", required=True, type=Path)
    parser.add_argument("--expected-remote", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()

    checkout = arguments.aider.resolve()
    remote = run_git(checkout, "remote", "get-url", "origin")
    commit = run_git(checkout, "rev-parse", "HEAD")
    if remote != arguments.expected_remote or commit != arguments.expected_commit:
        raise SystemExit(
            f"Unexpected aider source: remote={remote!r}, commit={commit!r}"
        )

    os.environ["AIDER_ANALYTICS"] = "false"
    sys.path.insert(0, str(checkout))

    from aider.args import get_parser
    from aider.coders import editblock_coder
    from aider.coders.chat_chunks import ChatChunks
    from aider.io import InputOutput
    from aider.models import Model
    from aider.repo import GitRepo
    from aider.repomap import RepoMap

    fixture = {
        "schemaVersion": 1,
        "upstream": {"repository": remote, "commit": commit},
        "sources": {
            "configPrecedence": "aider/main.py:451-504; aider/args.py:35-54",
            "chatChunks": "aider/coders/chat_chunks.py:5-64",
            "searchReplace": "aider/coders/editblock_coder.py:127-217,335-590",
            "gitDiff": "aider/repo.py:375-417",
            "repoMap": "aider/repomap.py:266-784",
        },
        "configPrecedence": export_config_precedence(get_parser),
        "chatChunks": export_chat_chunks(ChatChunks),
        "searchReplace": export_search_replace(editblock_coder),
        "gitDiff": export_git_diff(InputOutput, GitRepo),
        "repoMap": export_repo_map(InputOutput, Model, RepoMap),
    }

    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(fixture, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"Wrote {arguments.output}")


if __name__ == "__main__":
    main()
