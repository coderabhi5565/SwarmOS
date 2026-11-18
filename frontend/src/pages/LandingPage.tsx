import { ArrowRight, Gauge, GitBranch, RotateCw, ScanSearch, ShieldCheck, type LucideIcon } from "lucide-react";
import * as m from "motion/react-m";
import { Tabs } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { BackendStatus } from "@/app/layout/BackendStatus";
import { BeamDiagram } from "@/components/landing/BeamDiagram";
import { HeroVisual } from "@/components/landing/HeroVisual";
import { PhaseTicker } from "@/components/landing/PhaseTicker";
import type { PhaseId } from "@/components/landing/simulation";
import { SpotlightCard } from "@/components/landing/SpotlightCard";
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
    <div className="flex flex-col">
      <Hero />
      <div className="mx-auto w-full max-w-7xl space-y-20 px-4 py-14 sm:px-6 sm:py-20">
        <Architecture />
        <Walkthrough />
        <Honesty />
      </div>
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

/** A small lift on hover and a press on click; no movement under reduced motion. */
const CTA_MOTION =
  "transition-transform duration-150 motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]";

// ----------------------------------------------------------------------
function Hero() {
  // The phase the 3D scene is playing; null with the 2D diagram (no cycle to follow).
  const [phase, setPhase] = useState<PhaseId | null>(null);
  return (
    <section aria-labelledby="hero-heading" className="relative isolate flex flex-col overflow-hidden border-b border-border/50 lg:block lg:min-h-[680px]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(900px_520px_at_70%_40%,color-mix(in_oklch,var(--brand-violet)_14%,transparent),transparent_70%)]"
      />
      {/* The stage: the whole hero on a wide screen, a band under the copy on a narrow one. */}
      <HeroVisual
        onPhase={setPhase}
        className="order-last h-[360px] w-full lg:absolute lg:inset-0 lg:h-auto"
        fallbackClassName="lg:ml-auto lg:w-[56%] lg:pr-8"
      />
      {/* The copy passes pointer events through, so the stage behind stays draggable. */}
      <div className="pointer-events-none relative order-first mx-auto flex w-full max-w-7xl flex-col px-4 pt-12 pb-6 sm:px-6 lg:min-h-[680px] lg:justify-center lg:py-16">
        <Rise className="pointer-events-auto max-w-xl space-y-6">
          <BackendStatus />
          <h1 id="hero-heading" className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Deterministic{" "}
            <span className="landing-shimmer bg-gradient-to-r from-brand-cyan via-brand-violet to-brand-cyan bg-[length:200%_auto] bg-clip-text text-transparent">
              Multi-Agent
            </span>{" "}
            Orchestration.
          </h1>
          <p className="max-w-md text-base text-muted-foreground sm:text-lg">
            Parallel LangGraph waves, evidence-guarded reviews, and nanosecond span traces.
          </p>
          <PhaseTicker phase={phase} />
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild className={cn(CTA_MOTION, "shadow-[0_0_24px_-6px_var(--brand-cyan)]")}>
              <Link to="/runs/new">
                Launch Live Demo
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" className={CTA_MOTION}>
              <Link to="/benchmarks">Benchmarks</Link>
            </Button>
          </div>
        </Rise>
      </div>
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
              <SpotlightCard className="p-5 sm:p-6">
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
              </SpotlightCard>
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
/** How long the replay shows each stage. */
export const REPLAY_STEP_MS = 1600;

function Walkthrough() {
  const [active, setActive] = useState(WALKTHROUGH[0].id);
  const [replaying, setReplaying] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const activeIndex = WALKTHROUGH.findIndex((step) => step.id === active);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function stop() {
    window.clearTimeout(timer.current);
    setReplaying(false);
  }

  /** Walk the stages from the first, one every REPLAY_STEP_MS, and stop on the last. */
  function replay() {
    window.clearTimeout(timer.current);
    setReplaying(true);
    const show = (index: number) => {
      setActive(WALKTHROUGH[index].id);
      if (index === WALKTHROUGH.length - 1) {
        timer.current = window.setTimeout(() => setReplaying(false), REPLAY_STEP_MS);
      } else {
        timer.current = window.setTimeout(() => show(index + 1), REPLAY_STEP_MS);
      }
    };
    show(0);
  }

  return (
    <section aria-labelledby="walkthrough-heading" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading id="walkthrough-heading" eyebrow="Trace" title="One run, as the trace records it">
          Events from a recorded run of the catalog task "Parallel pipeline", unedited apart from leaving fields out.
        </SectionHeading>
        <div className="flex items-center gap-3">
          <p role="status" aria-label="Replay progress" className="font-mono text-[11px] text-muted-foreground">
            {replaying ? `Replaying: step ${activeIndex + 1} of ${WALKTHROUGH.length}` : ""}
          </p>
          <Button variant="outline" size="sm" onClick={replay} className={CTA_MOTION}>
            <RotateCw aria-hidden="true" />
            Replay Execution Cycle
          </Button>
        </div>
      </div>
      <BeamDiagram steps={WALKTHROUGH} activeIndex={activeIndex} />
      <Tabs.Root
        value={active}
        onValueChange={(value) => {
          stop(); // choosing a stage by hand ends a replay
          setActive(value);
        }}
        className="glass overflow-hidden rounded-2xl"
      >
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
