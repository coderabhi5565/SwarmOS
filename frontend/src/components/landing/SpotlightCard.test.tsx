import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeamDiagram, stepKinds } from "./BeamDiagram";
import { SpotlightCard } from "./SpotlightCard";
import { WALKTHROUGH } from "./traceWalkthrough";

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("prefers-reduced-motion"), media: query }));
}

afterEach(() => vi.unstubAllGlobals());

describe("SpotlightCard", () => {
  it("writes the pointer's position to CSS variables, relative to the card", () => {
    render(<SpotlightCard>content</SpotlightCard>);
    const card = screen.getByRole("article");
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ left: 100, top: 40 } as DOMRect);
    expect(card.style.getPropertyValue("--mouse-x")).toBe("");
    fireEvent.pointerMove(card, { clientX: 180, clientY: 65 });
    expect(card.style.getPropertyValue("--mouse-x")).toBe("80px");
    expect(card.style.getPropertyValue("--mouse-y")).toBe("25px");
    fireEvent.pointerMove(card, { clientX: 110, clientY: 140 });
    expect(card.style.getPropertyValue("--mouse-x")).toBe("10px");
    expect(card.style.getPropertyValue("--mouse-y")).toBe("100px");
  });

  it("keeps its glow decorative: hidden from assistive technology, never in the way of the pointer", () => {
    render(
      <SpotlightCard>
        <a href="/x">a link inside</a>
      </SpotlightCard>,
    );
    const card = screen.getByRole("article");
    const layers = [...card.querySelectorAll("[data-spotlight-layer]")];
    expect(layers.map((layer) => layer.getAttribute("data-spotlight-layer"))).toEqual(["border", "surface"]);
    for (const layer of layers) {
      expect(layer).toHaveAttribute("aria-hidden", "true");
      expect(layer).toHaveClass("pointer-events-none", "opacity-0", "motion-reduce:hidden");
      expect((layer as HTMLElement).style.background).toContain("var(--mouse-x, 50%) var(--mouse-y, 50%)");
    }
    expect(screen.getByRole("link", { name: "a link inside" })).toBeInTheDocument();
  });

  it("does not follow the pointer under reduced motion", () => {
    stubReducedMotion(true);
    render(<SpotlightCard>content</SpotlightCard>);
    const card = screen.getByRole("article");
    fireEvent.pointerMove(card, { clientX: 180, clientY: 65 });
    expect(card.style.getPropertyValue("--mouse-x")).toBe("");
    expect(card.style.getPropertyValue("--mouse-y")).toBe("");
  });
});

describe("BeamDiagram", () => {
  const stage = (id: string) => screen.getByTestId("beam-diagram").querySelector(`[data-stage="${id}"]`);
  const beam = (id: string) => screen.getByTestId("beam-diagram").querySelector(`[data-beam="${id}"]`);

  it("names each stage with the event kinds its recorded excerpts show", () => {
    expect(WALKTHROUGH.map(stepKinds)).toEqual([
      ["routing_decision"],
      ["routing_decision", "agent_invocation"],
      ["agent_invocation"],
      ["verification"],
    ]);
    render(<BeamDiagram steps={WALKTHROUGH} activeIndex={1} />);
    expect(stage("wave")).toHaveTextContent("Parallel waverouting_decisionagent_invocation");
    expect(stage("verify")).toHaveTextContent("Verifyverification");
  });

  it("lights the stage in view, animates the beam into it and marks what came before", () => {
    const { rerender } = render(<BeamDiagram steps={WALKTHROUGH} activeIndex={0} />);
    expect(stage("plan")).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("beam-diagram").querySelectorAll("[data-beam]")).toHaveLength(0);

    rerender(<BeamDiagram steps={WALKTHROUGH} activeIndex={2} />);
    expect(["plan", "wave", "review", "verify"].map((id) => stage(id)?.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "active",
      "idle",
    ]);
    expect(beam("wave")).toHaveAttribute("data-state", "done");
    expect(beam("wave")).not.toHaveClass("landing-beam");
    expect(beam("review")).toHaveAttribute("data-state", "active");
    expect(beam("review")).toHaveClass("landing-beam"); // the only moving beam
    expect(beam("verify")).toBeNull();
  });

  it("is a picture of the tabs, hidden from assistive technology", () => {
    render(<BeamDiagram steps={WALKTHROUGH} activeIndex={0} />);
    expect(screen.getByTestId("beam-diagram")).toHaveAttribute("aria-hidden", "true");
  });
});
