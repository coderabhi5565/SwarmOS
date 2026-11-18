import { ArrowRight, Gauge, GitBranch, ScanSearch, ShieldCheck, type LucideIcon } from "lucide-react";
import * as m from "motion/react-m";
import { Tabs } from "radix-ui";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { BackendStatus } from "@/app/layout/BackendStatus";
import { HeroVisual } from "@/components/landing/HeroVisual";
import { WALKTHROUGH, type TraceExcerpt } from "@/components/landing/traceWalkthrough";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The public front page. Everything it says describes code in this
 * repository; the walkthrough shows recorded trace events, and the footer
 * says plainly what the public deployment runs.
 */
export function LandingPage() {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-20 px-4 py-10 sm:px-6 sm:py-16">
      <Hero />
      <Architecture />
      <Walkthrough />
      <Honesty />
    </div>
  );
}

function Rise({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut", delay }}
    >
      {children}
    </m.div>
  );
}

// ----------------------------------------------------------------------
function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr]">
      <Rise className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-xs tracking-[0.2em] text-brand-cyan uppercase">Multi-agent coding orchestrator</p>
          <BackendStatus />
        </div>
        <h1 id="hero-heading" className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
          Agents that plan, code, review and verify.{" "}
          <span className="bg-gradient-to-r from-brand-cyan via-primary to-brand-violet bg-clip-text text-transparent">
            Every decision on the record.
          </span>
        </h1>
        <p className="max-w-xl text-base text-muted-foreground sm:text-lg">
          SwarmOS runs a planner, parallel coders, an evidence-checked reviewer and a deterministic test runner through
          one explicit state machine, with bounded retries and budgets. Each run leaves a typed, replayable trace.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link to="/runs/new">
              Launch Live Demo
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/benchmarks">Inspect Benchmarks</Link>
          </Button>
          <Link to="/app" className="px-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Open Workspace
          </Link>
        </div>
      </Rise>
      <Rise delay={0.08}>
        <div className="glass relative h-[300px] overflow-hidden rounded-2xl sm:h-[380px]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(420px_240px_at_50%_0%,color-mix(in_oklch,var(--brand-cyan)_12%,transparent),transparent_70%)]"
          />
          <HeroVisual className="size-full p-2" />
        </div>
        <p className="mt-2 text-center font-mono text-[11px] text-muted-foreground">
          planner → parallel coder wave → reviewer evidence guard → deterministic verifier
        </p>
      </Rise>
    </section>
  );
}

// ----------------------------------------------------------------------
interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
  points: string[];
  source: string[];
  span: string;
  tone: string;
}

const FEATURES: Feature[] = [
  {
    icon: GitBranch,
    title: "LangGraph parallel waves",
    body: "The plan's dependencies become waves. Steps of a wave fan out to coders that each work in their own checkout, and their results fold back through typed state reducers.",
    points: ["Typed state with merge reducers", "Dependency fan-out per wave", "Conflicting changes are rejected at merge"],
    source: ["app/orchestrator.py", "app/state.py"],
    span: "md:col-span-4",
    tone: "text-agent-coder",
  },
  {
    icon: ScanSearch,
    title: "Reviewer evidence guard",
    body: "A reviewer cannot block a run on a claim. A blocker must cite a real file, a line that exists and test output; otherwise the run ends as review_invalid, never as an approval.",
    points: ["Checks files, lines and test output", "review_invalid is its own terminal status"],
    source: ["app/review_evidence.py"],
    span: "md:col-span-2",
    tone: "text-agent-reviewer",
  },
  {
    icon: Gauge,
    title: "Monotonic span observability",
    body: "Run timings are spans on perf_counter_ns, never differences of wall-clock timestamps. Benchmarks exclude one warm-up per arm and task and report median and nearest-rank P95 with their n.",
    points: ["Nanosecond monotonic spans", "Warm-up excluded, missing values stay unknown"],
    source: ["app/timings/", "app/benchmarks/"],
    span: "md:col-span-2",
    tone: "text-brand-cyan",
  },
  {
    icon: ShieldCheck,
    title: "Fail-closed public sandbox",
    body: "The public demo runs only curated tasks. Generated code passes a static AST policy before merge, tests run under an audit-hooked pytest launcher, and every response is redacted. The server refuses to start if any of these is off.",
    points: ["Static AST code policy", "Audit-hooked pytest launcher", "Response redaction at the API boundary"],
    source: ["app/runtime/code_policy.py", "app/runtime/sandbox_launcher.py", "app/redaction.py"],
    span: "md:col-span-4",
    tone: "text-agent-verifier",
  },
];

function Architecture() {
  return (
    <section aria-labelledby="architecture-heading" className="space-y-6">
      <SectionHeading id="architecture-heading" eyebrow="Architecture" title="Four decisions that shape every run">
        Each card names the modules that implement it.
      </SectionHeading>
      <ul className="grid gap-4 md:grid-cols-6">
        {FEATURES.map((feature, index) => (
          <li key={feature.title} className={feature.span}>
            <Rise delay={0.04 * index} className="h-full">
              <article className="glass group h-full rounded-2xl p-5 transition-colors hover:border-foreground/25 sm:p-6">
                <feature.icon aria-hidden="true" className={cn("size-5", feature.tone)} />
                <h3 className="mt-3 text-lg font-semibold tracking-tight">{feature.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{feature.body}</p>
                <ul className="mt-4 flex flex-wrap gap-2">
                  {feature.points.map((point) => (
                    <li key={point} className="rounded-full border border-border/70 px-2.5 py-0.5 text-xs text-foreground/90">
                      {point}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 font-mono text-[11px] text-muted-foreground">{feature.source.join(" · ")}</p>
              </article>
            </Rise>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-xs tracking-[0.2em] text-brand-cyan uppercase">{eyebrow}</p>
      <h2 id={id} className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {title}
      </h2>
      <p className="max-w-2xl text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

// ----------------------------------------------------------------------
function Walkthrough() {
  return (
    <section aria-labelledby="walkthrough-heading" className="space-y-6">
      <SectionHeading id="walkthrough-heading" eyebrow="Trace" title="One run, as the trace records it">
        Events from a recorded run of the catalog task "Parallel pipeline", unedited apart from leaving fields out.
      </SectionHeading>
      <Tabs.Root defaultValue={WALKTHROUGH[0].id} className="glass overflow-hidden rounded-2xl">
        <Tabs.List aria-label="Stages of a run" className="flex gap-1 overflow-x-auto border-b border-border/70 p-2">
          {WALKTHROUGH.map((step, index) => (
            <Tabs.Trigger
              key={step.id}
              value={step.id}
              className="rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-accent data-[state=active]:text-accent-foreground"
            >
              <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{index + 1}</span>
              {step.tab}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {WALKTHROUGH.map((step) => (
          <Tabs.Content key={step.id} value={step.id} className="grid gap-5 p-4 outline-none sm:p-6 lg:grid-cols-[1fr_1.4fr]">
            <div className="space-y-2">
              <h3 className="text-lg font-semibold tracking-tight">{step.title}</h3>
              <p className="text-sm text-muted-foreground">{step.explanation}</p>
            </div>
            <ol aria-label={`Trace events: ${step.tab}`} className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-3 font-mono text-xs">
              {step.events.map((event) => (
                <TraceEvent key={event.seq} event={event} />
              ))}
            </ol>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </section>
  );
}

function TraceEvent({ event }: { event: TraceExcerpt }) {
  return (
    <li className="space-y-1">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground">seq {event.seq}</span>
        <span className="text-brand-cyan">{event.kind}</span>
        <span className="font-sans text-foreground">{event.message}</span>
      </p>
      <pre className="overflow-x-auto rounded-md bg-card/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </li>
  );
}

// ----------------------------------------------------------------------
function Honesty() {
  return (
    <footer className="space-y-4">
      <aside
        role="note"
        aria-label="About this deployment"
        className="rounded-2xl border border-status-findings/30 bg-status-findings/5 p-5 text-sm sm:p-6"
      >
        <p className="font-medium text-foreground">What the public deployment runs</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            The <span className="text-foreground">deterministic scripted provider</span>: the agents follow a script, so
            results describe the orchestration, not a model's ability.
          </li>
          <li>Curated catalog tasks only. Free-form goals, uploads and provider overrides are refused.</li>
          <li>Ephemeral SQLite storage on a free tier: run history resets when the server restarts or redeploys.</li>
          <li>A free-tier backend sleeps when idle; the first request can take up to a minute.</li>
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">A ₹0/month architecture: a static frontend and one small API process.</p>
      </aside>
      <p className="text-center text-xs text-muted-foreground">
        SwarmOS is a portfolio project. Benchmarks report measured trials with their sample sizes and claim no
        statistical significance.
      </p>
    </footer>
  );
}
