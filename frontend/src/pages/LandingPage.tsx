import { ArrowRight, Gauge, GitBranch, RotateCw, ScanSearch, ShieldCheck, type LucideIcon } from "lucide-react";
import * as m from "motion/react-m";
import { Tabs } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { BackendStatus } from "@/app/layout/BackendStatus";
import { EvidenceGuardDemo, SandboxChecks, SpanWaterfall, WaveGantt } from "@/components/landing/ArchitectureWidgets";
import { BeamDiagram } from "@/components/landing/BeamDiagram";
import { HeroVisual } from "@/components/landing/HeroVisual";
import { PhaseTicker } from "@/components/landing/PhaseTicker";
import { Reveal, ScrollProgress } from "@/components/landing/Reveal";
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
      <ScrollProgress className="sticky top-14 z-30" />
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
  /** One line; the widget shows the rest. */
  caption: string;
  widget: ReactNode;
  source: string[];
  span: string;
  tone: string;
}

const FEATURES: Feature[] = [
  {
    icon: GitBranch,
    title: "LangGraph parallel waves",
    caption: "Independent steps fan out together and fold back through typed state reducers.",
    widget: <WaveGantt />,
    source: ["app/orchestrator.py", "app/state.py"],
    span: "md:col-span-4",
    tone: "text-agent-coder",
  },
  {
    icon: ScanSearch,
    title: "Reviewer evidence guard",
    caption: "A blocker needs a real file, line and test output.",
    widget: <EvidenceGuardDemo />,
    source: ["app/review_evidence.py"],
    span: "md:col-span-2",
    tone: "text-agent-reviewer",
  },
  {
    icon: Gauge,
    title: "Monotonic span observability",
    caption: "Timings are spans on one monotonic clock, never wall-clock subtraction.",
    widget: <SpanWaterfall />,
    source: ["app/timings/", "app/benchmarks/"],
    span: "md:col-span-2",
    tone: "text-brand-cyan",
  },
  {
    icon: ShieldCheck,
    title: "Fail-closed public sandbox",
    caption: "Curated tasks only; the server refuses to start with any check off.",
    widget: <SandboxChecks />,
    source: ["app/runtime/code_policy.py", "app/runtime/sandbox_launcher.py", "app/redaction.py"],
    span: "md:col-span-4",
    tone: "text-agent-verifier",
  },
];

function Architecture() {
  return (
    <section aria-labelledby="architecture-heading" className="space-y-6">
      <Reveal>
        <SectionHeading id="architecture-heading" eyebrow="Architecture" title="Four decisions that shape every run" />
      </Reveal>
      <ul className="grid gap-4 md:grid-cols-6">
        {FEATURES.map((feature, index) => (
          <li key={feature.title} className={feature.span}>
            <Reveal delay={0.06 * index} className="h-full">
              <SpotlightCard className="flex flex-col gap-4 p-5 sm:p-6">
                <div>
                  <div className="flex items-center gap-2">
                    <feature.icon aria-hidden="true" className={cn("size-4", feature.tone)} />
                    <h3 className="text-base font-semibold tracking-tight">{feature.title}</h3>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{feature.caption}</p>
                </div>
                <div className="flex-1 rounded-xl border border-border/50 bg-background/40 p-3">{feature.widget}</div>
                <p className="font-mono text-[11px] text-muted-foreground">{feature.source.join(" · ")}</p>
              </SpotlightCard>
            </Reveal>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-xs tracking-[0.2em] text-brand-cyan uppercase">{eyebrow}</p>
      <h2 id={id} className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {title}
      </h2>
      {children && <p className="max-w-2xl text-sm text-muted-foreground">{children}</p>}
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
      <Reveal className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading id="walkthrough-heading" eyebrow="Trace" title="One run, as the trace records it">
          A recorded run of the catalog task "Parallel pipeline". Fields are left out; none is changed.
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
      </Reveal>
      <Reveal delay={0.05}>
        <BeamDiagram steps={WALKTHROUGH} activeIndex={activeIndex} />
      </Reveal>
      <Reveal delay={0.1}>
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
              <m.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25 }} className="space-y-2">
                <h3 className="text-lg font-semibold tracking-tight">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.explanation}</p>
              </m.div>
              <ol aria-label={`Trace events: ${step.tab}`} className="space-y-3 rounded-xl border border-border/60 bg-background/60 p-3 font-mono text-xs">
                {step.events.map((event, index) => (
                  <TraceEvent key={event.seq} event={event} delay={index * 0.18} />
                ))}
              </ol>
            </Tabs.Content>
          ))}
        </Tabs.Root>
      </Reveal>
    </section>
  );
}

/** One recorded event; its payload is revealed line by line. */
function TraceEvent({ event, delay }: { event: TraceExcerpt; delay: number }) {
  const lines = JSON.stringify(event.payload, null, 2).split("\n");
  return (
    <m.li className="space-y-1" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay }}>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground">seq {event.seq}</span>
        <span className="text-brand-cyan">{event.kind}</span>
        <span className="font-sans text-foreground">{event.message}</span>
      </p>
      <pre className="overflow-x-auto rounded-md bg-card/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
        {lines.map((line, index) => (
          <m.span
            key={index}
            className="block"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12, delay: delay + 0.1 + index * 0.04 }}
          >
            {line}
          </m.span>
        ))}
      </pre>
    </m.li>
  );
}

// ----------------------------------------------------------------------
const DEPLOYMENT = ["Scripted Demo Provider", "Curated Catalog Tasks", "Ephemeral SQLite", "₹0/mo Architecture"];

function Honesty() {
  return (
    <Reveal>
      <footer className="space-y-3">
        <aside
          role="note"
          aria-label="About this deployment"
          className="glass flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full px-5 py-2.5 font-mono text-xs text-foreground/90"
        >
          {DEPLOYMENT.map((fact, index) => (
            <span key={fact} className="flex items-center gap-3">
              {index > 0 && (
                <span aria-hidden="true" className="text-muted-foreground/60">
                  •
                </span>
              )}
              {fact}
            </span>
          ))}
        </aside>
        <p className="text-center text-xs text-muted-foreground">
          Scripted results describe the orchestration, not a model. History resets on restart, and a sleeping free-tier
          server can take a minute to wake. Benchmarks claim no statistical significance.
        </p>
      </footer>
    </Reveal>
  );
}
