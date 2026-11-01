import type { ExecutionState, InvocationStatus } from "@/domain/execution";
import { invocationsOf } from "@/domain/execution";
import { formatDuration, formatTokens } from "./format";
import { EmptyLine, RoleDot, Section, ToneBadge, Unknown, Value, type Tone } from "./primitives";

const INVOCATION_TONE: Record<InvocationStatus, Tone> = {
  running: "live",
  succeeded: "completed",
  failed: "failed",
  skipped: "muted",
  interrupted: "cancelled",
};

export function InvocationTable({ state }: { state: ExecutionState }) {
  const rows = invocationsOf(state);
  return (
    <Section
      id="invocations"
      title="Model calls"
      description="Every agent call in trace order, including failed attempts. Verification is not a model call and is listed separately."
    >
      {rows.length === 0 ? (
        <EmptyLine>No model calls recorded.</EmptyLine>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-x-1 text-left text-sm">
            <thead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 font-normal">Agent</th>
                <th scope="col" className="py-2 font-normal">Step</th>
                <th scope="col" className="py-2 font-normal">Attempt</th>
                <th scope="col" className="py-2 font-normal">Model</th>
                <th scope="col" className="py-2 font-normal">Status</th>
                <th scope="col" className="py-2 text-right font-normal">Latency</th>
                <th scope="col" className="py-2 text-right font-normal">Tokens in / out</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((call) => (
                <tr key={call.id} className="border-t border-border/50 align-top">
                  <td className="py-2">
                    <span className="flex items-center gap-2 capitalize">
                      <RoleDot role={call.role} />
                      {call.role}
                    </span>
                    {!call.startObserved && (
                      <span className="block text-[11px] text-muted-foreground/70">start not recorded</span>
                    )}
                  </td>
                  <td className="py-2 font-mono text-xs">{call.stepId ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="py-2 font-mono text-xs">
                    <Value value={call.attempt} missing="?" />
                  </td>
                  <td className="py-2 font-mono text-xs">
                    <Value value={call.model} />
                    {call.tier && <span className="block text-[11px] text-muted-foreground">{call.tier} tier</span>}
                  </td>
                  <td className="py-2">
                    <ToneBadge tone={INVOCATION_TONE[call.status]}>{call.status}</ToneBadge>
                    {call.errorClass && (
                      <span className="mt-1 block font-mono text-[11px] text-status-failed">{call.errorClass}</span>
                    )}
                  </td>
                  <td className="py-2 text-right font-mono text-xs">
                    <Value value={formatDuration(call.latencyMs)} missing={call.status === "running" ? "in progress" : "not recorded"} />
                  </td>
                  <td className="py-2 text-right font-mono text-xs">
                    {call.inputTokens === null ? (
                      <Unknown>not reported</Unknown>
                    ) : (
                      `${formatTokens(call.inputTokens)} / ${formatTokens(call.outputTokens)}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
