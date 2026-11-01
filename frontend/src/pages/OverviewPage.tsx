import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { useDemoTasks, useHealth, useRunHistory } from "@/api/queries";
import type { DemoTask, RunSummary } from "@/api/types";
import { RunStatusBadge } from "@/components/run/RunStatusBadge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const AGENTS = [
  { role: "Planner", tone: "bg-agent-planner", detail: "Turns a goal into a dependency-aware plan." },
  { role: "Coder", tone: "bg-agent-coder", detail: "Implements independent steps in parallel waves." },
  { role: "Reviewer", tone: "bg-agent-reviewer", detail: "Rejects only with evidenced blockers." },
  { role: "Verifier", tone: "bg-agent-verifier", detail: "Runs the real tests: a deterministic runner, not a model." },
] as const;

export function OverviewPage() {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">
          Adaptive multi-agent orchestration
        </p>
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Plan, code, review and verify, with every decision on the record.
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          SwarmOS coordinates four agents through an explicit state machine with bounded
          retries, budgets and an evidence-checked reviewer. Every run leaves a typed trace.
        </p>
      </section>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {AGENTS.map((agent) => (
          <li key={agent.role} className="glass rounded-xl p-4">
            <div className="flex items-center gap-2 font-medium">
              <span aria-hidden="true" className={`size-2 rounded-full ${agent.tone}`} />
              {agent.role}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{agent.detail}</p>
          </li>
        ))}
      </ul>

      <div className="grid gap-4 lg:grid-cols-2">
        <CatalogCard />
        <RecentRunsCard />
      </div>

      <BackendCard />
    </div>
  );
}

function CatalogCard() {
  const tasks = useDemoTasks();
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle>Demo tasks</CardTitle>
        <CardDescription>The curated runs the public demo accepts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {tasks.isPending && <ListSkeleton rows={2} />}
        {tasks.isError && <ErrorLine error={tasks.error} />}
        {tasks.data?.tasks.map((task) => <CatalogTask key={task.id} task={task} />)}
      </CardContent>
    </Card>
  );
}

function CatalogTask({ task }: { task: DemoTask }) {
  const parallel = task.waves.some((wave) => wave.length > 1);
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{task.title}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {task.steps.length} step{task.steps.length === 1 ? "" : "s"} · {task.waves.length} wave
          {task.waves.length === 1 ? "" : "s"}
          {parallel ? " · parallel" : ""}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{task.description}</p>
    </div>
  );
}

function RecentRunsCard() {
  const history = useRunHistory(6);
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle>Recent runs</CardTitle>
        <CardDescription>Newest first, from the run history API.</CardDescription>
      </CardHeader>
      <CardContent>
        {history.isPending && <ListSkeleton rows={4} />}
        {history.isError && <ErrorLine error={history.error} />}
        {history.isSuccess && runs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No runs yet. Start one from the <Link className="text-primary hover:underline" to="/console">console</Link>.
          </p>
        )}
        <ul className="divide-y divide-border/60">
          {runs.map((run) => <RecentRun key={run.run_id} run={run} />)}
        </ul>
      </CardContent>
    </Card>
  );
}

function RecentRun({ run }: { run: RunSummary }) {
  return (
    <li>
      <Link
        to={`/runs/${encodeURIComponent(run.run_id)}`}
        className="group flex items-center gap-3 py-2.5 hover:text-foreground"
      >
        <RunStatusBadge status={run.status} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">{run.goal}</span>
        <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

function BackendCard() {
  const health = useHealth();
  if (!health.data) return null;
  const facts = [
    ["Mode", health.data.mode],
    ["Provider", health.data.provider_kind],
    ["Version", health.data.version],
    ["Auth", health.data.auth_required ? "token required" : "open"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-4">
      {facts.map(([term, value]) => (
        <div key={term} className="rounded-lg border border-border/60 px-3 py-2">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="mt-0.5 text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function ErrorLine({ error }: { error: Error }) {
  return (
    <p role="alert" className="text-sm text-status-failed">
      {error.message}
    </p>
  );
}
