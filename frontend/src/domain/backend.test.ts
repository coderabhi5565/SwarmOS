import { describe, expect, it } from "vitest";
import type { Health } from "@/api/types";
import { describeBackend } from "@/domain/backend";

const base: Health = {
  status: "ok",
  service: "swarmos",
  version: "0.3.0",
  mode: "local",
  provider_mode: "auto",
  provider_kind: "local",
  openai_configured: true,
  auth_required: false,
};

describe("describeBackend", () => {
  it("names the configured endpoint when runs will use it", () => {
    expect(describeBackend(base)).toEqual({ mode: "local", provider: "local model" });
    expect(describeBackend({ ...base, provider_kind: "remote" }).provider).toBe("hosted model");
  });

  it("never claims a model when the server forces the demo fixture", () => {
    // A local endpoint is configured, but provider_mode "demo" means no model is called.
    expect(describeBackend({ ...base, provider_mode: "demo" }).provider).toBe("demo fixture");
  });

  it("labels the public demo", () => {
    expect(describeBackend({ ...base, mode: "public_demo", provider_kind: "demo" })).toEqual({
      mode: "public demo",
      provider: "demo fixture",
    });
  });
});
