import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { focusedNode, focusReducer, NO_FOCUS, type FocusState } from "./heroFocus";
import { HeroHud } from "./HeroHud";
import { connectedEdges, PIPELINE_NODES } from "./pipeline";

describe("hero focus", () => {
  const reduce = (state: FocusState, ...actions: Parameters<typeof focusReducer>[1][]) => actions.reduce(focusReducer, state);

  it("focuses a hovered node, and lets go when the pointer leaves it", () => {
    const hovering = reduce(NO_FOCUS, { type: "hover", id: "reviewer" });
    expect(focusedNode(hovering)).toBe("reviewer");
    expect(focusedNode(reduce(hovering, { type: "leave", id: "reviewer" }))).toBeNull();
    // A late leave from another node does not clear the current hover.
    expect(focusedNode(reduce(hovering, { type: "leave", id: "planner" }))).toBe("reviewer");
  });

  it("locks on click, over any hover, until toggled, replaced or cleared", () => {
    const locked = reduce(NO_FOCUS, { type: "toggle", id: "coder-b" });
    expect(locked.locked).toBe("coder-b");
    expect(focusedNode(reduce(locked, { type: "hover", id: "verifier" }))).toBe("coder-b");
    expect(focusedNode(reduce(locked, { type: "toggle", id: "coder-b" }))).toBeNull();
    expect(reduce(locked, { type: "toggle", id: "verifier" }).locked).toBe("verifier");
    const cleared = reduce(locked, { type: "hover", id: "verifier" }, { type: "clear" });
    expect(cleared.locked).toBeNull();
    expect(focusedNode(cleared)).toBe("verifier"); // the hover remains
  });

  it("highlights the paths into and out of a node", () => {
    expect(connectedEdges("planner")).toEqual(["planner>coder-a", "planner>coder-b", "planner>coder-c"]);
    expect(connectedEdges("coder-b")).toEqual(["planner>coder-b", "coder-b>reviewer"]);
    expect(connectedEdges("reviewer")).toEqual(["coder-a>reviewer", "coder-b>reviewer", "coder-c>reviewer", "reviewer>verifier"]);
    expect(connectedEdges("verifier")).toEqual(["reviewer>verifier"]);
  });
});

/** The HUD wired to the real reducer, as the scene wires it. */
function Harness() {
  const [focus, dispatch] = useReducer(focusReducer, NO_FOCUS);
  return (
    <HeroHud focused={focusedNode(focus)} locked={focus.locked} onSelect={(id) => dispatch({ type: "toggle", id })} />
  );
}

describe("HeroHud", () => {
  it("shows no telemetry until a node is in focus", () => {
    render(<HeroHud focused={null} locked={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Focus a pipeline node" })).toBeInTheDocument();
  });

  it("offers every node as a button and locks the one chosen", async () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Focus a pipeline node" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(PIPELINE_NODES.map((node) => node.label));
    expect(buttons.every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);

    await userEvent.click(within(group).getByRole("button", { name: "Reviewer evidence guard" }));
    expect(within(group).getByRole("button", { name: "Reviewer evidence guard" })).toHaveAttribute("aria-pressed", "true");
    const telemetry = screen.getByRole("status", { name: "Telemetry: Reviewer evidence guard" });
    expect(telemetry).toHaveTextContent("locked");
    expect(telemetry).toHaveTextContent("guard: review_invalid check");
    expect(telemetry).toHaveTextContent("evidence: file · line · test output");

    await userEvent.click(within(group).getByRole("button", { name: "Reviewer evidence guard" })); // again: unlock
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("works from the keyboard", async () => {
    render(<Harness />);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Planner" })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Coder B" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status", { name: "Telemetry: Coder B" })).toHaveTextContent("span: coder_critical_path_ms");
  });

  it("shows a hovered node's telemetry without a lock", () => {
    render(<HeroHud focused="verifier" locked={null} onSelect={vi.fn()} />);
    const telemetry = screen.getByRole("status", { name: "Telemetry: Deterministic verifier" });
    expect(telemetry).toHaveTextContent("sandbox: audit_hook + rlimits");
    expect(telemetry).toHaveTextContent("runner: deterministic_subprocess");
    expect(telemetry).not.toHaveTextContent("locked");
  });

  it("names what is recorded, and quotes no figure", () => {
    for (const node of PIPELINE_NODES) {
      expect(node.telemetry.length).toBeGreaterThan(0);
      for (const line of node.telemetry) expect(line).not.toMatch(/\d/);
    }
  });
});
