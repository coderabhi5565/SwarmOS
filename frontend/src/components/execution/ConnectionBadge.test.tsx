import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConnectionStatus } from "@/api/liveConnection";
import { ConnectionBadge } from "./ConnectionBadge";

describe("ConnectionBadge", () => {
  it.each<[ConnectionStatus, string]>([
    ["idle", "connecting to the live stream…"],
    ["connecting", "connecting to the live stream…"],
    ["connected", "live · streaming"],
    ["reconnecting", "reconnecting…"],
    ["polling", "polling fallback · every second"],
    ["disconnected", "offline · disconnected"],
  ])("names the %s state of a live run", (connection, text) => {
    render(<ConnectionBadge connection={connection} live error={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("only says live while a stream is open", () => {
    for (const connection of ["connecting", "reconnecting", "polling", "disconnected"] as const) {
      const { unmount } = render(<ConnectionBadge connection={connection} live error={null} />);
      expect(screen.queryByText(/live · streaming/)).not.toBeInTheDocument();
      expect(document.querySelector(".animate-pulse")).toBeNull();
      unmount();
    }
    render(<ConnectionBadge connection="connected" live error={null} />);
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("tells a reachable backend from a healthy stream", () => {
    render(<ConnectionBadge connection="polling" live error={null} />);
    expect(screen.getByRole("status").getAttribute("title")).toMatch(/stream is unavailable, but the backend answers/);
  });

  it("reports a failing fallback as a connection problem", () => {
    render(<ConnectionBadge connection="polling" live error={new Error("trace store unavailable")} />);
    expect(screen.getByRole("status")).toHaveTextContent("Connection problem (trace store unavailable)");
  });

  it("says updates stopped once the run is finished", () => {
    const { rerender } = render(<ConnectionBadge connection="completed" live error={null} />);
    expect(screen.getByText("updates stopped: run finished")).toBeInTheDocument();
    rerender(<ConnectionBadge connection="idle" live={false} error={null} />);
    expect(screen.getByText("updates stopped: run finished")).toBeInTheDocument();
  });
});
