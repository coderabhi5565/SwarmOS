"""The pure selection helpers agree with the code paths runs actually use.

Benchmarks describe each configuration (provider, models, limits) without
starting a run, so these helpers must give exactly what a run would get.
"""

from __future__ import annotations

import pytest

from app.models import Limits
from app.providers import ProviderConfigError, provider_name_for, resolve_provider
from app.runtime.runtime import RunRuntime, model_profiles, select_role_profile
from app.service import RunService, clamp_limits, effective_provider_choice
from tests.conftest import make_settings

ENDPOINT = {"base_url": "http://127.0.0.1:11434/v1", "fast_model": "small"}
STRONG = {**ENDPOINT, "strong_model": "large", "role_models": "planner=strong,reviewer=strong"}


@pytest.mark.parametrize("overrides", [{}, ENDPOINT, STRONG])
@pytest.mark.parametrize("choice", ["auto", "demo", "openai"])
def test_provider_name_matches_resolve_provider(tmp_path, overrides, choice):
    settings = make_settings(tmp_path, **overrides)
    try:
        _, expected, _ = resolve_provider(choice, settings)
    except ProviderConfigError:
        with pytest.raises(ProviderConfigError):
            provider_name_for(choice, settings)
        return
    assert provider_name_for(choice, settings) == expected


def test_the_demo_provider_never_offers_a_strong_model(tmp_path):
    settings = make_settings(tmp_path, **STRONG)
    assert settings.escalation_available  # the endpoint has one...
    assert set(model_profiles("demo", settings)) == {"fast"}  # ...the demo fixture does not
    assert model_profiles("demo", settings)["fast"].model == "demo-fast"
    assert set(model_profiles("openai-compatible:local", settings)) == {"fast", "strong"}


@pytest.mark.parametrize("policy", ["config", "fast_only", "adaptive", "role_routed"])
@pytest.mark.parametrize("provider", ["demo", "openai-compatible:local"])
def test_role_selection_matches_the_runtime(tmp_path, policy, provider):
    settings = make_settings(tmp_path, **STRONG)
    runtime = RunRuntime(
        run_id="run_sel",
        settings=settings,
        limits=Limits(),
        provider=None,  # type: ignore[arg-type]
        provider_name=provider,
        provider_warning=None,
        model_policy=policy,
    )
    try:
        for role in ("planner", "coder", "reviewer"):
            expected = runtime.selection_for_role(role)
            assert select_role_profile(role, policy, model_profiles(provider, settings), settings) == expected
    finally:
        runtime.cleanup()


def test_role_routing_picks_strong_only_where_configured(tmp_path):
    settings = make_settings(tmp_path, **STRONG)
    profiles = model_profiles("openai-compatible:local", settings)
    picks = {role: select_role_profile(role, "role_routed", profiles, settings).model for role in ("planner", "coder", "reviewer")}
    assert picks == {"planner": "large", "coder": "small", "reviewer": "large"}
    assert select_role_profile("planner", "fast_only", profiles, settings).model == "small"


@pytest.mark.parametrize("policy", ["config", "fast_only", "adaptive", "role_routed"])
def test_clamp_limits_matches_the_service(tmp_path, policy):
    settings = make_settings(tmp_path, max_agent_calls=5, max_escalations=1)
    service = RunService(settings, store=None)  # type: ignore[arg-type]
    requested = Limits(max_agent_calls=30, max_escalations=2, parallel_coding=False)
    assert clamp_limits(requested, policy, settings) == service.clamp_limits(requested, policy)
    clamped = clamp_limits(requested, policy, settings)
    assert clamped.max_agent_calls == 5
    assert clamped.max_escalations == (0 if policy == "fast_only" else 1)
    assert clamped.parallel_coding is False


@pytest.mark.parametrize("configured", ["demo", "openai", "auto", "bogus"])
@pytest.mark.parametrize("requested", ["auto", "demo", "openai"])
def test_provider_choice_matches_the_service(tmp_path, configured, requested):
    settings = make_settings(tmp_path, provider=configured)
    service = RunService(settings, store=None)  # type: ignore[arg-type]
    assert effective_provider_choice(requested, settings) == service.effective_provider(requested)
