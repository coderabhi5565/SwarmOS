"""Escalation is judged from the provider a run actually uses.

A configured endpoint with a distinct strong model makes escalation possible
for runs on that endpoint, never for runs on the demo fixture, which has a
single scripted model.
"""

from __future__ import annotations

from app.models import Limits
from app.providers.base import ProviderError
from app.runtime.runtime import escalation_possible, model_profiles
from tests.conftest import (
    ScriptedProvider,
    make_settings,
    plan_response,
    review_response,
)
from tests.test_routing import SINGLE_STEP_PLAN

STRONG_ENDPOINT = {
    "base_url": "http://127.0.0.1:1/v1",
    "fast_model": "fast-model",
    "strong_model": "strong-model",
}


def failing_coder(request, index):
    if request.role == "planner":
        return plan_response(SINGLE_STEP_PLAN)
    if request.role == "coder":
        raise ProviderError("model unavailable")
    return review_response()


class DemoNamedProvider(ScriptedProvider):
    """The scripted double, resolved as the demo fixture is."""

    name = "demo"


async def test_a_demo_run_never_escalates_even_with_a_strong_endpoint_configured(build_run):
    provider = DemoNamedProvider(failing_coder)
    orchestrator, runtime, record = build_run(
        provider, limits=Limits(max_retries=1, max_escalations=1), **STRONG_ENDPOINT
    )
    assert runtime.settings.escalation_available  # the endpoint could escalate...
    assert runtime.escalation_available is False  # ...this run's provider cannot

    result = await orchestrator.run(record)

    coder_calls = [call for call in provider.calls if call.role == "coder"]
    assert len(coder_calls) == 2  # initial + one retry, no escalated attempt
    assert {call.model for call in provider.calls} == {"demo-fast"}
    assert result.record.status == "failed"
    assert result.record.escalations == 0
    assert not any(
        event.kind == "escalation" and event.payload.get("available") for event in result.events
    )
    # It ends as an ordinary failure, not a crash on a missing strong model.
    assert not any(
        event.kind == "failure" and event.payload.get("error_class") == "run_crashed"
        for event in result.events
    )
    assert "Escalation: unavailable" in result.record.summary


async def test_a_real_provider_still_escalates_to_its_strong_model(build_run):
    provider = ScriptedProvider(failing_coder)
    orchestrator, runtime, record = build_run(
        provider, limits=Limits(max_retries=1, max_escalations=1), **STRONG_ENDPOINT
    )
    assert runtime.escalation_available is True

    result = await orchestrator.run(record)

    coder_calls = [call for call in provider.calls if call.role == "coder"]
    assert len(coder_calls) == 3  # initial + retry + escalated attempt
    assert coder_calls[-1].model == "strong-model"
    assert result.record.escalations == 1


def test_escalation_possible_follows_the_provider_profiles(tmp_path):
    settings = make_settings(tmp_path, **STRONG_ENDPOINT)
    assert escalation_possible(model_profiles("demo", settings)) is False
    assert escalation_possible(model_profiles("openai-compatible:local", settings)) is True
    without_strong = make_settings(tmp_path, **{**STRONG_ENDPOINT, "strong_model": ""})
    assert escalation_possible(model_profiles("openai-compatible:local", without_strong)) is False
