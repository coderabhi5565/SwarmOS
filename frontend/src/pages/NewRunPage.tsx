import { ArrowRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "@/api/client";
import { useCreateRun, useDemoTasks, useHealth } from "@/api/queries";
import type { DemoTask, RunRequest } from "@/api/types";
import { ToneBadge } from "@/components/execution/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Start a run from the curated catalog: the only kind of run the public
 * demo accepts. No free-form goal, files, or provider choice is offered.
 */
export function NewRunPage() {
  const tasks = useDemoTasks();
  const health = useHealth();
  const create = useCreateRun();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const task = tasks.data?.tasks.find((candidate) => candidate.id === selected) ?? null;

  function start() {
    if (!task) return;
    const body: RunRequest = { goal: task.goal, demo_task: task.id as RunRequest["demo_task"] };
    create.mutate(body, {
      onSuccess: (detail) => navigate(`/runs/${encodeURIComponent(detail.run.run_id)}`),
    });
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">New run</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Choose a task to orchestrate</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each task is a fixed recipe: a goal, a plan with dependencies, the files the coder may change and
          read-only tests. The agents, the review guard and real test verification run for real.
        </p>
        {health.data?.mode === "local" && (
          <p className="text-xs text-muted-foreground">
            Local mode: free-form goals are available in the{" "}
            <Link className="text-primary hover:underline" to="/legacy">
              legacy console
            </Link>
            .
          </p>
        )}
      </header>

      {tasks.isPending && (
        <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
          {tasks.failureCount > 0 && (
            <p role="status" className="text-sm text-status-live lg:col-span-2">
              Waking the server… a free-tier backend can take up to a minute after a quiet period.
            </p>
          )}
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      )}
      {tasks.isError && (
        <p role="alert" className="text-status-failed">
          Could not load the task catalog: {tasks.error.message}
        </p>
      )}

      {tasks.data && (
        <fieldset>
          <legend className="sr-only">Catalog tasks</legend>
          <div className="grid gap-4 lg:grid-cols-2">
            {tasks.data.tasks.map((candidate) => (
              <TaskOption
                key={candidate.id}
                task={candidate}
                selected={candidate.id === selected}
                onSelect={() => {
                  setSelected(candidate.id);
                  create.reset();
                }}
              />
            ))}
          </div>
        </fieldset>
      )}

      <div className="glass flex flex-wrap items-center gap-3 rounded-xl p-4">
        <Button size="lg" disabled={!task || create.isPending} onClick={start}>
          {create.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <ArrowRight aria-hidden="true" />}
          {create.isPending ? "Starting…" : "Start run"}
        </Button>
        <p className="text-sm text-muted-foreground">
          {task ? (
            <>
              <span className="text-foreground">{task.title}</span> · up to {task.limits.max_agent_calls} model calls,{" "}
              {task.limits.max_wall_seconds} s
            </>
          ) : (
            "Select a task to start."
          )}
        </p>
        {create.isError && <SubmitError error={create.error} />}
      </div>
    </div>
  );
}

function TaskOption({ task, selected, onSelect }: { task: DemoTask; selected: boolean; onSelect: () => void }) {
  const parallel = task.waves.some((wave) => wave.length > 1);
  return (
    <label
      className={cn(
        "glass block cursor-pointer rounded-xl p-4 transition-colors sm:p-5",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        selected ? "border-primary/70 bg-primary/5" : "hover:border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          name="catalog-task"
          value={task.id}
          checked={selected}
          onChange={onSelect}
          className="mt-1 size-4 accent-[var(--primary)]"
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{task.title}</span>
            <ToneBadge tone="muted">
              {task.steps.length} step{task.steps.length === 1 ? "" : "s"} · {task.waves.length} wave
              {task.waves.length === 1 ? "" : "s"}
            </ToneBadge>
            {parallel && <ToneBadge tone="live">parallel</ToneBadge>}
          </div>
          <p className="text-sm text-muted-foreground">{task.description}</p>
          <ol className="space-y-1">
            {task.steps.map((step) => (
              <li key={step.id} className="font-mono text-xs">
                <span className="text-brand-cyan">{step.id}</span>
                <span className="text-muted-foreground">
                  {step.depends_on.length > 0 ? ` ← after ${step.depends_on.join(", ")}` : " · no dependencies"}
                </span>
              </li>
            ))}
          </ol>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground sm:grid-cols-4">
            <div>
              <dt>calls</dt>
              <dd className="text-foreground">{task.limits.max_agent_calls}</dd>
            </div>
            <div>
              <dt>retries</dt>
              <dd className="text-foreground">{task.limits.max_retries}</dd>
            </div>
            <div>
              <dt>revisions</dt>
              <dd className="text-foreground">{task.limits.max_revisions}</dd>
            </div>
            <div>
              <dt>wall clock</dt>
              <dd className="text-foreground">{task.limits.max_wall_seconds} s</dd>
            </div>
          </dl>
          <p className="font-mono text-[11px] text-muted-foreground">
            writes {task.allowed_files.join(", ")} · read-only {task.read_only_files.join(", ")}
          </p>
        </div>
      </div>
    </label>
  );
}

/** What the server said, in terms a visitor can act on. */
function SubmitError({ error }: { error: Error }) {
  let title = "The run could not be started.";
  if (error instanceof ApiError) {
    if (error.status === 429) {
      title = error.retryAfter
        ? `Busy right now. Try again in ${formatWait(error.retryAfter)}.`
        : "Busy right now. Try again shortly.";
    } else if (error.status === 403) {
      title = "Not available in the public demo.";
    } else if (error.status === 422) {
      title = "The request was not valid.";
    }
  } else {
    title = "Could not reach the server. A sleeping free-tier backend can take up to a minute to wake; try again shortly.";
  }
  return (
    <div role="alert" className="basis-full text-sm">
      <p className="text-status-failed">{title}</p>
      {error instanceof ApiError && <p className="mt-0.5 text-xs text-muted-foreground">{error.message}</p>}
    </div>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  return `${Math.ceil(seconds / 60)} min`;
}
