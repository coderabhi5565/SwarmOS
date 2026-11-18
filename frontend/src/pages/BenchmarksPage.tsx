import { ArrowRight, Loader2, RotateCw } from "lucide-react";
import { Link } from "react-router";
import { useMe } from "@/api/auth";
import {
  experimentsFromPages,
  isActiveExperiment,
  useBenchmarkExperiments,
  useBenchmarkSuites,
} from "@/api/benchmarkQueries";
import type { BenchmarkExperimentSummary } from "@/api/types";
import { SignInPrompt } from "@/components/auth/SignInPrompt";
import { ExperimentStatusBadge, ProvenanceBadge } from "@/components/benchmarks/badges";
import { CreateExperimentForm } from "@/components/benchmarks/CreateExperimentForm";
import { formatDate, formatDuration } from "@/components/execution/format";
import { Unknown, Value } from "@/components/execution/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 20;

/**
 * Benchmark experiments, newest first, from the cursor-paged experiment
 * list. The list refreshes itself while any loaded experiment is active.
 */
export function BenchmarksPage() {
  const list = useBenchmarkExperiments(PAGE_SIZE);
  const experiments = experimentsFromPages(list.data);
  const scripted = experiments.some((experiment) => experiment.scripted);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">Benchmarks</p>
        <h1 className="text-2xl font-semibold tracking-tight">Experiments</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each experiment runs fixed configurations (arms) on a fixed, versioned suite of tasks through the same
          orchestration as any run. No arm is declared best: open an experiment for its trials and runs.
        </p>
      </header>

      <CreateExperimentPanel />

      {scripted && (
        <p role="note" className="glass rounded-xl border-status-findings/30 px-4 py-3 text-sm text-status-findings">
          Experiments marked <span className="font-medium">scripted provider</span> ran on the demo fixture: the agents
          follow a script, so their results describe the orchestration, not a model&apos;s ability.
        </p>
      )}

      {list.isPending && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading experiments">
          {list.failureCount > 0 && (
            <p role="status" className="text-sm text-status-live">
              Waking the server… a free-tier backend can take up to a minute after a quiet period.
            </p>
          )}
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      )}

      {list.isError && !list.isFetchNextPageError && (
        <div role="alert" className="glass flex flex-wrap items-center gap-3 rounded-xl p-4">
          <p className="text-status-failed">Could not load experiments: {list.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => void list.refetch()} disabled={list.isFetching}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      {list.isSuccess && experiments.length === 0 && (
        <div className="glass rounded-xl p-8 text-center">
          <p className="font-medium">No experiments yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Experiments appear here once one has been started on this server.
          </p>
        </div>
      )}

      {experiments.length > 0 && (
        <ul className="glass divide-y divide-border/50 overflow-hidden rounded-xl" aria-label="Experiments">
          {experiments.map((experiment) => (
            <ExperimentRow key={experiment.experiment_id} experiment={experiment} />
          ))}
        </ul>
      )}

      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage && <Loader2 aria-hidden="true" className="animate-spin" />}
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      {list.isFetchNextPageError && (
        <p role="alert" className="text-center text-sm text-status-failed">
          Could not load more experiments: {list.error?.message}
        </p>
      )}
    </div>
  );
}

/**
 * Experiment creation, only where the server says it accepts experiments
 * (its suites response's can_create: in the public demo, for operators
 * only). The form, and with it the create mutation, is never mounted
 * otherwise; in the public demo a prompt says who may start one instead.
 */
function CreateExperimentPanel() {
  const suites = useBenchmarkSuites();
  const me = useMe();
  if (suites.isPending) return null;
  if (suites.isError) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Could not load the benchmark options ({suites.error.message}); the experiment list below still works.
      </p>
    );
  }
  if (!suites.data.can_create && suites.data.mode === "public_demo" && !me.isPending) {
    return me.signedIn ? (
      <SignInPrompt title="Experiments are for operators" signIn={false}>
        You are signed in as a user: you can start catalog runs, but in the public demo only operators start or cancel
        experiments. The experiments below are open to everyone.
      </SignInPrompt>
    ) : (
      <SignInPrompt title="Operators start experiments">
        Sign in with the operator account to start or cancel experiments. Everyone can open the experiments below.
      </SignInPrompt>
    );
  }
  if (!suites.data.can_create) {
    return (
      <p role="note" aria-label="Read-only" className="glass rounded-xl px-4 py-3 text-sm text-muted-foreground">
        Read-only: this server does not accept new experiments. The experiments below were started by its operator;
        open one for its trials and runs.
      </p>
    );
  }
  return <CreateExperimentForm suites={suites.data} />;
}

function ExperimentRow({ experiment }: { experiment: BenchmarkExperimentSummary }) {
  const active = isActiveExperiment(experiment.status);
  const elapsed = elapsedMs(experiment.started_at, experiment.finished_at);
  return (
    <li>
      <Link
        to={`/benchmarks/${encodeURIComponent(experiment.experiment_id)}`}
        className="group grid gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent/30 md:grid-cols-[11rem_minmax(0,1fr)_auto]"
        aria-label={`Experiment ${experiment.experiment_id}: ${experiment.suite_title}, ${experiment.status}`}
      >
        <div className="space-y-1">
          <ExperimentStatusBadge status={experiment.status} />
          <p className="font-mono text-[11px] text-muted-foreground">{experiment.experiment_id}</p>
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-sm">
            {experiment.suite_title}{" "}
            <span className="font-mono text-[11px] text-muted-foreground">{experiment.suite_version}</span>
          </p>
          <dl className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
            <div className="flex gap-1">
              <dt>trials</dt>
              <dd className="text-foreground">
                {experiment.trials_done}/{experiment.trials_total} done
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>arms</dt>
              <dd>{experiment.arm_ids.join(", ")}</dd>
            </div>
            <div className="flex gap-1">
              <dt>created</dt>
              <dd>
                <Value value={formatDate(experiment.created_at)} />
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>finished</dt>
              <dd>
                {experiment.finished_at ? formatDate(experiment.finished_at) : active ? "in progress" : <Unknown />}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>took</dt>
              <dd>{active ? "in progress" : <Value value={formatDuration(elapsed)} />}</dd>
            </div>
          </dl>
          {experiment.error && <p className="truncate text-xs text-muted-foreground">{experiment.error}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <ProvenanceBadge scripted={experiment.scripted} />
          <span className="font-mono text-[11px] text-muted-foreground">
            {experiment.provider} ({experiment.provider_kind})
          </span>
          <ArrowRight
            aria-hidden="true"
            className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 md:block"
          />
        </div>
      </Link>
    </li>
  );
}

/** Milliseconds between two recorded timestamps; null when either is missing or unreadable. */
function elapsedMs(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? null : end - start;
}
