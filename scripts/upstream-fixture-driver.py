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
    def normalize(messages):
        normalized = json.loads(json.dumps(messages))
        for message in normalized:
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if "cache_control" in part:
                    part["cacheControl"] = part.pop("cache_control")
        return normalized

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
        "withCacheHeaders": normalize(chunks.all_messages()),
        "cacheable": normalize(chunks.cacheable_messages()),
    }


def export_fences(all_fences):
    def choose(contents):
        lines = "".join(content + "\n" for content in contents).splitlines()
        for fence_open, fence_close in all_fences:
            if any(
                line.startswith(fence_open) or line.startswith(fence_close)
                for line in lines
            ):
                continue
            return {"fence": [fence_open, fence_close], "fellBack": False}
        return {"fence": list(all_fences[0]), "fellBack": True}

    exhausted = [value for fence in all_fences for value in fence]
    return {
        "candidates": all_fences,
        "cases": {
            "empty": choose([]),
            "tripleBackticks": choose(["before\n```text\nafter"]),
            "quadrupleBackticks": choose(["````text"]),
            "indentedBackticks": choose(["  ```text"]),
            "exhausted": choose(exhausted),
        },
    }


def export_prompt_resources(CoderPrompts):
    fields = {
        "systemReminder": "system_reminder",
        "filesContentGptEdits": "files_content_gpt_edits",
        "filesContentGptEditsNoRepo": "files_content_gpt_edits_no_repo",
        "filesContentGptNoEdits": "files_content_gpt_no_edits",
        "filesContentLocalEdits": "files_content_local_edits",
        "lazyPrompt": "lazy_prompt",
        "overeagerPrompt": "overeager_prompt",
        "exampleMessages": "example_messages",
        "filesContentPrefix": "files_content_prefix",
        "filesContentAssistantReply": "files_content_assistant_reply",
        "filesNoFullFiles": "files_no_full_files",
        "filesNoFullFilesWithRepoMap": "files_no_full_files_with_repo_map",
        "filesNoFullFilesWithRepoMapReply": "files_no_full_files_with_repo_map_reply",
        "repoContentPrefix": "repo_content_prefix",
        "readOnlyFilesPrefix": "read_only_files_prefix",
        "shellCmdPrompt": "shell_cmd_prompt",
        "shellCmdReminder": "shell_cmd_reminder",
        "noShellCmdPrompt": "no_shell_cmd_prompt",
        "noShellCmdReminder": "no_shell_cmd_reminder",
        "renameWithShell": "rename_with_shell",
        "goAheadTip": "go_ahead_tip",
    }
    return {target: getattr(CoderPrompts, source) for target, source in fields.items()}


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
    # RepoMap opens a SQLite tags cache under the map root. Windows refuses to
    # unlink an open file, so the cache is closed before the directory goes away
    # and a cleanup failure is never allowed to mask a real export error.
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        definitions = root / "definitions.py"
        usage = root / "usage.py"
        definitions.write_text(
            'def greet(name):\n    return f"Hello {name}"\n\n'
            'def farewell(name):\n    return f"Goodbye {name}"\n',
            encoding="utf-8",
        )
        usage.write_text(
            'from definitions import farewell, greet\n\n'
            'print(greet("Ada"))\nprint(greet("Grace"))\nprint(farewell("Linus"))\n',
            encoding="utf-8",
        )
        repository_map = RepoMap(
            map_tokens=512,
            root=directory,
            main_model=Model("gpt-3.5-turbo"),
            io=InputOutput(pretty=False, fancy_input=False),
            refresh="always",
        )
        files = [str(definitions), str(usage)]

        def normalize_tag(tag):
            return {
                "path": tag.rel_fname.replace(os.sep, "/"),
                "line": tag.line,
                "name": tag.name,
                "kind": "definition" if tag.kind == "def" else "reference",
            }

        tags = []
        for file in files:
            tags.extend(
                normalize_tag(tag)
                for tag in repository_map.get_tags(file, Path(file).name)
                if tag.line >= 0
            )
        tags = [dict(items) for items in sorted({tuple(sorted(tag.items())) for tag in tags})]
        ranked = repository_map.get_ranked_tags([], files, set(), set())
        rank_order = [
            f"{tag.rel_fname.replace(os.sep, '/')}:{tag.name}:{tag.line}"
            for tag in ranked
            if hasattr(tag, "kind")
        ]
        rendered = repository_map.get_repo_map([], files)
        normalized = [
            line.removeprefix("│").rstrip()
            for line in rendered.splitlines()
            if line.strip() and line.strip() != "⋮"
        ]
        cache = getattr(repository_map, "TAGS_CACHE", None)
        if hasattr(cache, "close"):
            cache.close()
        return {
            "tags": tags,
            "rankOrder": rank_order,
            "rendered": rendered,
            "normalizedMap": normalized,
        }


# One small file per language Patch ships a grammar for. Each is written to a
# temporary map root and tagged by aider's own extractor, so Patch's eleven
# languages are pinned against upstream rather than against themselves.
REPO_MAP_LANGUAGE_SAMPLES = {
    "sample.js": "function javascriptName() {}\njavascriptName();\n",
    "sample.ts": "function typescriptName(): void {}\ntypescriptName();\n",
    "sample.tsx": (
        "export function TsxName() {\n  return null;\n}\nconst used = TsxName;\n"
    ),
    "sample.py": "def python_name():\n    pass\n\npython_name()\n",
    "sample.go": "package main\nfunc goName() {}\nfunc main() { goName() }\n",
    "sample.rs": "fn rust_name() {}\nfn main() { rust_name(); }\n",
    "sample.sh": "bash_name() {\n  echo hi\n}\nbash_name\n",
    "sample.cpp": "int cppName() { return 0; }\nint main() { return cppName(); }\n",
    "sample.cs": (
        "class CsharpName {\n"
        "  public CsharpName Make() { return new CsharpName(); }\n"
        "}\n"
    ),
    "sample.java": "class JavaName {\n  void run() {}\n}\n",
    "sample.rb": "def ruby_name\n  1\nend\nruby_name\n",
}


def export_repo_map_languages(InputOutput, Model, RepoMap):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        for name, source in REPO_MAP_LANGUAGE_SAMPLES.items():
            (root / name).write_text(source, encoding="utf-8")
        repository_map = RepoMap(
            map_tokens=512,
            root=directory,
            main_model=Model("gpt-3.5-turbo"),
            io=InputOutput(pretty=False, fancy_input=False),
            refresh="always",
        )
        languages = {}
        for name in sorted(REPO_MAP_LANGUAGE_SAMPLES):
            tags = [
                {
                    "line": tag.line,
                    "name": tag.name,
                    "kind": "definition" if tag.kind == "def" else "reference",
                }
                for tag in repository_map.get_tags(str(root / name), name)
                if tag.line >= 0
            ]
            # The source travels with its tags so the consuming test extracts
            # from exactly what upstream tagged, not from a second copy.
            languages[name] = {
                "source": REPO_MAP_LANGUAGE_SAMPLES[name],
                "tags": sorted(
                    (
                        dict(items)
                        for items in {tuple(sorted(tag.items())) for tag in tags}
                    ),
                    key=lambda tag: (tag["line"], tag["kind"], tag["name"]),
                ),
            }
        cache = getattr(repository_map, "TAGS_CACHE", None)
        if hasattr(cache, "close"):
            cache.close()
        return languages


def export_important_files(filter_important_files):
    candidates = [
        "README.md",
        "src/main.ts",
        ".github/workflows/ci.yml",
        ".github/workflows/notes.txt",
        "package.json",
        "docs/guide.md",
        "Makefile",
        "requirements.txt",
        ".gitignore",
        "deep/nested/README.md",
    ]
    return {
        "candidates": candidates,
        "important": list(filter_important_files(candidates)),
    }


# A single response carrying two files, so the file-header transition between
# hunks is pinned and not only the hunks themselves.
UNIFIED_DIFF_RESPONSE = """Here are the changes.

```diff
--- a/first.py
+++ b/first.py
@@ ... @@
 def first():
-    return 1
+    return 2
--- a/second.py
+++ b/second.py
@@ ... @@
 def second():
-    return "old"
+    return "new"
```
"""


def export_unified_diff(udiff_coder):
    diffs = udiff_coder.find_diffs(UNIFIED_DIFF_RESPONSE)
    exported = []
    for path, hunk in diffs:
        before, after = udiff_coder.hunk_to_before_after(hunk, lines=True)
        exported.append(
            {
                "path": path,
                "hunk": list(hunk),
                "before": "".join(before),
                "after": "".join(after),
            }
        )
    applied = udiff_coder.directly_apply_hunk(
        'def first():\n    return 1\n', diffs[0][1]
    )
    return {"response": UNIFIED_DIFF_RESPONSE, "diffs": exported, "applied": applied}


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

    from aider import coders
    from aider.args import get_parser
    from aider.coders.base_coder import all_fences
    from aider.coders.base_prompts import CoderPrompts
    from aider.coders import editblock_coder
    from aider.coders import udiff_coder
    from aider.coders.chat_chunks import ChatChunks
    from aider.io import InputOutput
    from aider.models import Model
    from aider.repo import GitRepo
    from aider.repomap import RepoMap
    from aider.special import filter_important_files

    fixture = {
        "schemaVersion": 5,
        "upstream": {"repository": remote, "commit": commit},
        "sources": {
            "configPrecedence": "aider/main.py:451-504; aider/args.py:35-54",
            "chatChunks": "aider/coders/chat_chunks.py:5-64",
            "fences": "aider/coders/base_coder.py:73-84,609-629",
            "promptResources": "aider/coders/base_prompts.py:1-60",
            "editFormats": "aider/coders/__init__.py:1-34",
            "searchReplace": "aider/coders/editblock_coder.py:127-217,335-590",
            "gitDiff": "aider/repo.py:375-417",
            "repoMap": "aider/repomap.py:266-784",
            "repoMapLanguages": "aider/repomap.py:266-784; aider/queries/tree-sitter-language-pack/*-tags.scm",
            "importantFiles": "aider/special.py:184-205",
            "unifiedDiff": "aider/coders/udiff_coder.py:261-435",
        },
        "configPrecedence": export_config_precedence(get_parser),
        "chatChunks": export_chat_chunks(ChatChunks),
        "fences": export_fences(all_fences),
        "promptResources": export_prompt_resources(CoderPrompts),
        "editFormats": sorted(
            coder.edit_format
            for coder in coders.__all__
            if getattr(coder, "edit_format", None) is not None
        ),
        "searchReplace": export_search_replace(editblock_coder),
        "gitDiff": export_git_diff(InputOutput, GitRepo),
        "repoMap": export_repo_map(InputOutput, Model, RepoMap),
        "repoMapLanguages": export_repo_map_languages(InputOutput, Model, RepoMap),
        "importantFiles": export_important_files(filter_important_files),
        "unifiedDiff": export_unified_diff(udiff_coder),
    }

    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(fixture, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"Wrote {arguments.output}")


if __name__ == "__main__":
    main()
