"""`swarmos bench` on the benchmark runner: usability and JSONL compatibility."""

from __future__ import annotations

import json

import pytest

import app.cli as cli
from app.benchmarks.legacy import BenchmarkResult
from app.benchmarks.store import BenchmarkStore
from app.store import RunStore
from tests.conftest import make_settings


@pytest.fixture
def bench(tmp_path, monkeypatch, capsys):
    db = tmp_path / "bench.db"

    def run(*args: str, **settings_overrides):
        monkeypatch.setattr(cli, "settings", make_settings(tmp_path, **settings_overrides))
        code = cli.main(["--db", str(db), "bench", *args])
        out = capsys.readouterr()
        return code, out.out, out.err

    run.db = db
    return run


def stored(db):
    store = RunStore(db)
    benchmarks = BenchmarkStore(store)
    experiments = benchmarks.list_experiments_page(50)[0]
    trials = {e.experiment_id: benchmarks.get_trials(e.experiment_id) for e in experiments}
    store.close()
    return experiments, trials


def test_bench_runs_the_default_policies_and_keeps_the_jsonl_format(bench, tmp_path):
    out_file = tmp_path / "results.jsonl"
    code, out, _ = bench("--provider", "demo", "--limit", "1", "--seed", "3", "--out", str(out_file))
    assert code == 0

    lines = [json.loads(line) for line in out_file.read_text(encoding="utf-8").splitlines()]
    assert len(lines) == 3
    # Exactly the fields the JSONL has always had.
    assert all(set(line) == set(BenchmarkResult.model_fields) for line in lines)
    assert sorted(line["policy"] for line in lines) == ["adaptive", "fixed-fast", "multi-agent"]
    assert {line["task_id"] for line in lines} == {"sample_tag_normalization"}
    assert all(line["provider"] == "demo" and line["status"] == "completed" for line in lines)
    # Unreported usage is null, never zero (the approved change).
    assert all(line["input_tokens"] is None and line["cost_usd"] is None for line in lines)
    assert all(line["escalation_available"] is False for line in lines)

    assert "Scripted provider" in out
    assert "run identically by construction" in out
    assert "No policy is declared best" in out

    experiments, trials = stored(bench.db)
    (experiment,) = experiments
    assert experiment.status == "completed" and experiment.origin == "cli"
    assert experiment.suite_id == "catalog" and experiment.order_seed == 3
    assert sorted(t.run_id for t in trials[experiment.experiment_id]) == sorted(line["run_id"] for line in lines)


def test_bench_compares_the_execution_arms(bench):
    code, out, _ = bench("--provider", "demo", "--arm", "parallel", "sequential", "--limit", "1")
    assert code == 0
    assert "parallel" in out and "sequential" in out
    experiments, _ = stored(bench.db)
    assert experiments[0].arm_ids == ["parallel", "sequential"]


def test_the_default_suite_follows_the_provider(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "settings", make_settings(tmp_path))
    assert cli._default_suite("demo") == "catalog"
    assert cli._default_suite("openai") == "local-fixtures"  # unconfigured: refused later
    monkeypatch.setattr(cli, "settings", make_settings(tmp_path, provider="auto", base_url="http://127.0.0.1:1/v1", fast_model="m"))
    assert cli._default_suite("auto") == "local-fixtures"


def test_bench_refuses_what_it_cannot_run(bench):
    code, _, err = bench("--provider", "demo", "--suite", "local-fixtures")
    assert code == 2
    assert "needs a real model" in err
    assert stored(bench.db)[0] == []


def test_a_stale_experiment_blocks_bench_until_recovered(bench):
    # A bench process died mid-experiment.
    store = RunStore(bench.db)
    from app.benchmarks.runner import ExperimentRunner
    from app.service import RunService

    runner = ExperimentRunner(RunService(make_settings(bench.db.parent), store), BenchmarkStore(store))
    stale = runner.create("catalog", ["parallel"], origin="cli", task_ids=["sample_tag_normalization"])
    runner.benchmarks.save_experiment(stale.model_copy(update={"status": "running"}))
    store.close()

    code, _, err = bench("--provider", "demo", "--arm", "parallel", "--limit", "1")
    assert code == 2
    assert "only one experiment may be active" in err
    assert "swarmos bench --recover" in err

    code, out, _ = bench("--recover")
    assert code == 0 and stale.experiment_id in out
    code, _, _ = bench("--provider", "demo", "--arm", "parallel", "--limit", "1")
    assert code == 0
    statuses = {e.experiment_id: e.status for e in stored(bench.db)[0]}
    assert statuses[stale.experiment_id] == "interrupted"
    assert sorted(statuses.values()) == ["completed", "interrupted"]
