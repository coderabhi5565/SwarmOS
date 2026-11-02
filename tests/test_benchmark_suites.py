from __future__ import annotations

import shutil

import pytest

from app.benchmarks.suites import (
    SAMPLE_PROJECT,
    SuiteError,
    all_suites,
    catalog_suite,
    directory_digest,
    get_suite,
    local_fixtures_suite,
)
from app.demo_tasks import demo_catalog


def test_the_catalog_suite_is_the_public_catalog():
    suite = catalog_suite()
    assert suite.public is True
    assert suite.requires_real_model is False
    assert [task.id for task in suite.tasks] == [task.id for task in demo_catalog()]
    assert all(task.demo_task == task.id for task in suite.tasks)
    # The recipe limits travel with the task: they are the ceiling a run gets.
    for task, demo in zip(suite.tasks, demo_catalog(), strict=True):
        assert task.limits == demo.limits
        assert task.goal == demo.goal


def test_parallel_waves_are_known_for_catalog_tasks():
    tasks = {task.id: task for task in catalog_suite().tasks}
    assert tasks["sample_tag_normalization"].parallel_waves is False
    assert tasks["sample_parallel_pipeline"].parallel_waves is True


def test_local_fixtures_are_local_only_and_need_a_real_model():
    suite = local_fixtures_suite()
    assert suite.public is False
    assert suite.requires_real_model is True
    assert len(suite.tasks) >= 3
    assert all(task.demo_task is None and task.parallel_waves is None for task in suite.tasks)


def test_versions_are_stable():
    assert catalog_suite().version == catalog_suite().version
    assert local_fixtures_suite().version == local_fixtures_suite().version
    assert catalog_suite().version.startswith("v1-")
    assert catalog_suite().version != local_fixtures_suite().version


def test_the_version_follows_the_task_definitions(tmp_path):
    original = local_fixtures_suite().version
    tasks = tmp_path / "tasks.jsonl"
    tasks.write_text(
        '{"id":"only","category":"coding","goal":"Do something different here."}\n',
        encoding="utf-8",
    )
    assert local_fixtures_suite(tasks).version != original


def test_the_version_follows_the_sample_project(tmp_path):
    copy = tmp_path / "sample"
    shutil.copytree(SAMPLE_PROJECT, copy, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    assert catalog_suite(copy).version == catalog_suite().version
    (copy / "target.py").write_text("# changed\n", encoding="utf-8")
    assert catalog_suite(copy).version != catalog_suite().version


def test_the_digest_ignores_caches_and_line_endings(tmp_path):
    (tmp_path / "a.py").write_bytes(b"x = 1\n")
    before = directory_digest(tmp_path)
    (tmp_path / "__pycache__").mkdir()
    (tmp_path / "__pycache__" / "a.pyc").write_bytes(b"junk")
    (tmp_path / "a.py").write_bytes(b"x = 1\r\n")
    assert directory_digest(tmp_path) == before


def test_suites_are_looked_up_by_id():
    assert set(all_suites()) == {"catalog", "local-fixtures"}
    assert get_suite("catalog").id == "catalog"
    with pytest.raises(SuiteError):
        get_suite("anything-else")
    with pytest.raises(SuiteError):
        catalog_suite().task("missing")
