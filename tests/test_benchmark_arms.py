from __future__ import annotations

import asyncio
import json

import pytest

from app.benchmarks.arms import ARMS, ArmError, get_arm
from app.benchmarks.legacy import POLICIES
from app.benchmarks.provenance import (
    arm_configuration,
    collect_provenance,
    identical_by_design,
    resolve_policy,
)
from app.benchmarks.suites import catalog_suite, local_fixtures_suite
from app.models import RunRequest
from app.providers import ProviderConfigError
from app.service import RunService
from app.store import RunStore
from tests.conftest import make_settings

SECRET_KEY = "sk-arms-test-secret-000"
PRIVATE_URL = "http://10.20.30.40:11434/v1"
ENDPOINT = {"base_url": PRIVATE_URL, "fast_model": "small", "api_key": SECRET_KEY}
STRONG = {**ENDPOINT, "strong_model": "large", "role_models": "planner=strong,reviewer=strong"}

CATALOG = {task.id: task for task in catalog_suite().tasks}
SAMPLE = CATALOG["sample_tag_normalization"]
PIPELINE = CATALOG["sample_parallel_pipeline"]
FIXTURE = local_fixtures_suite().tasks[0]
KINDS = {arm.id: arm.kind for arm in ARMS.values()}


def configs(task, settings, arm_ids, provider="auto"):
    return [arm_configuration(get_arm(arm_id), task, settings, provider) for arm_id in arm_ids]


# ----------------------------------------------------------------------
# arms
# ----------------------------------------------------------------------
def test_the_arms_are_fixed_and_named():
    assert set(ARMS) == {"parallel", "sequential", "fixed-fast", "adaptive", "multi-agent"}
    assert {arm.id for arm in ARMS.values() if arm.kind == "execution"} == {"parallel", "sequential"}
    with pytest.raises(ArmError):
        get_arm("anything")


def test_the_legacy_policies_are_the_model_policy_arms():
    for name, policy in POLICIES.items():
        arm = ARMS[name]
        assert (policy.model_policy, policy.max_escalations) == (arm.model_policy, arm.max_escalations)


def test_an_arm_changes_only_its_own_dimension():
    sequential = get_arm("sequential").requested_limits(PIPELINE)
    assert sequential == PIPELINE.limits.model_copy(update={"parallel_coding": False})
    adaptive = get_arm("adaptive").requested_limits(FIXTURE)
    assert adaptive == FIXTURE.limits.model_copy(update={"max_escalations": 1})


def test_requests_are_ordinary_run_requests():
    request = get_arm("sequential").request(PIPELINE)
    assert isinstance(request, RunRequest)
    assert request.demo_task == "sample_parallel_pipeline"
    assert request.goal == PIPELINE.goal
    assert request.provider == "auto"
    assert request.files == {}
    assert request.limits.parallel_coding is False

    fixture = get_arm("fixed-fast").request(FIXTURE, provider="openai", budget_usd=0.5)
    assert fixture.demo_task is None
    assert fixture.model_policy == "fast_only"
    assert fixture.limits.max_budget_usd == 0.5


# ----------------------------------------------------------------------
# configurations
# ----------------------------------------------------------------------
def test_the_demo_fixture_cannot_escalate_whatever_endpoint_is_configured(tmp_path):
    settings = make_settings(tmp_path, **STRONG)
    assert settings.escalation_available  # the endpoint could...
    config = arm_configuration(get_arm("adaptive"), FIXTURE, settings, provider="demo")
    assert config.provider == "demo" and config.scripted is True
    assert config.escalation_possible is False  # ...the provider this arm uses cannot
    assert "the demo fixture has a single scripted model" in config.escalation_unavailable
    assert set(config.models_by_role.values()) == {"demo-fast", "deterministic-subprocess"}


def test_a_real_strong_model_makes_the_policies_differ(tmp_path):
    settings = make_settings(tmp_path, **STRONG)
    found = {c.arm_id: c for c in configs(FIXTURE, settings, ["fixed-fast", "adaptive", "multi-agent"], "openai")}
    assert found["fixed-fast"].escalation_possible is False
    assert found["adaptive"].escalation_possible is True
    assert found["multi-agent"].models_by_role["planner"] == "large"
    assert found["adaptive"].models_by_role["planner"] == "small"
    assert len({c.fingerprint for c in found.values()}) == 3
    assert identical_by_design(list(found.values()), KINDS) == []


def test_policies_are_identical_by_design_on_the_scripted_catalog(tmp_path):
    settings = make_settings(tmp_path)
    found = configs(SAMPLE, settings, ["fixed-fast", "adaptive", "multi-agent"])
    groups = identical_by_design(found, KINDS)
    assert len(groups) == 1
    group = groups[0]
    assert sorted(group.arm_ids) == ["adaptive", "fixed-fast", "multi-agent"]
    assert any("same model for each role" in reason for reason in group.reasons)
    assert any("allows no escalation" in reason for reason in group.reasons)
    assert any("single scripted model" in reason for reason in group.reasons)
    assert "not evidence" in group.explanation


def test_the_catalog_allows_no_escalation_even_with_a_real_strong_model(tmp_path):
    settings = make_settings(tmp_path, **STRONG)
    config = arm_configuration(get_arm("adaptive"), SAMPLE, settings, provider="openai")
    assert config.escalation_possible is False
    assert config.escalation_unavailable == ["the task 'sample_tag_normalization' allows no escalation"]


def test_execution_arms_differ_only_where_a_wave_runs_in_parallel(tmp_path):
    settings = make_settings(tmp_path)
    on_sample = identical_by_design(configs(SAMPLE, settings, ["parallel", "sequential"]), KINDS)
    assert len(on_sample) == 1
    assert "no wave with more than one step" in on_sample[0].reasons[0]
    on_pipeline = configs(PIPELINE, settings, ["parallel", "sequential"])
    assert on_pipeline[0].fingerprint != on_pipeline[1].fingerprint
    assert identical_by_design(on_pipeline, KINDS) == []


def test_fingerprints_ignore_names_and_follow_behaviour(tmp_path):
    settings = make_settings(tmp_path)
    again = arm_configuration(get_arm("parallel"), PIPELINE, settings)
    assert again.fingerprint == arm_configuration(get_arm("parallel"), PIPELINE, settings).fingerprint
    lower_ceiling = arm_configuration(get_arm("parallel"), PIPELINE, make_settings(tmp_path, max_agent_calls=3))
    assert lower_ceiling.limits.max_agent_calls == 3
    assert lower_ceiling.fingerprint != again.fingerprint


def test_limits_are_clamped_like_a_run(tmp_path):
    settings = make_settings(tmp_path, max_agent_calls=4, max_wall_seconds=60)
    config = arm_configuration(get_arm("parallel"), PIPELINE, settings)
    assert config.limits.max_agent_calls == 4
    assert config.limits.max_wall_seconds == 60
    assert config.limits.max_retries == PIPELINE.limits.max_retries


def test_an_unusable_provider_is_refused(tmp_path):
    with pytest.raises(ProviderConfigError):
        arm_configuration(get_arm("adaptive"), FIXTURE, make_settings(tmp_path), provider="openai")


@pytest.mark.parametrize("requested", [None, "fast_only", "adaptive", "role_routed"])
@pytest.mark.parametrize("default", ["config", "adaptive", "bogus"])
def test_policy_resolution_matches_the_service(tmp_path, requested, default):
    settings = make_settings(tmp_path, model_policy=default)
    service = RunService(settings, store=None)  # type: ignore[arg-type]
    assert resolve_policy(requested, settings) == service.resolve_policy(requested)


@pytest.mark.parametrize("arm_id", ["sequential", "adaptive"])
def test_the_configuration_is_what_a_real_run_records(tmp_path, arm_id):
    """Predicted provider, models and limits match a demo run of the arm."""
    settings = make_settings(tmp_path)
    store = RunStore(tmp_path / "arms.db")
    try:
        arm = get_arm(arm_id)
        record = asyncio.run(RunService(settings, store).run_request(arm.request(PIPELINE)))
        config = arm_configuration(arm, PIPELINE, settings)
        assert record.provider == config.provider
        assert record.provider_kind == config.provider_kind
        assert record.model_policy == config.model_policy
        assert record.models_by_role == config.models_by_role
        assert record.limits == config.limits
    finally:
        store.close()


# ----------------------------------------------------------------------
# environment provenance
# ----------------------------------------------------------------------
def test_provenance_describes_the_environment_without_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("SWARMOS_BUILD_COMMIT", "abc1234")
    settings = make_settings(tmp_path, **STRONG)
    real = collect_provenance(settings, provider="openai")
    assert real.provider == "openai-compatible:remote"
    assert real.scripted is False
    assert real.build_commit == "abc1234"
    assert real.verification_command == settings.verification_command

    scripted = collect_provenance(settings, provider="demo")
    assert scripted.scripted is True
    # A scripted run is never presented as priced, whatever the endpoint's rates.
    assert scripted.monetary_enforced is False and scripted.pricing_known is False

    for item in (real, scripted):
        text = json.dumps(item.model_dump())
        assert SECRET_KEY not in text
        assert PRIVATE_URL not in text and "10.20.30.40" not in text


def test_provenance_without_a_build_commit(tmp_path, monkeypatch):
    monkeypatch.delenv("SWARMOS_BUILD_COMMIT", raising=False)
    assert collect_provenance(make_settings(tmp_path)).build_commit is None
