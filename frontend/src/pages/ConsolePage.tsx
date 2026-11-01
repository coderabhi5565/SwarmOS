import LegacyDashboard from "@/App";

/** The pre-redesign dashboard, unchanged, inside the new shell. */
export function ConsolePage() {
  return (
    <div className="legacy-console">
      <LegacyDashboard />
    </div>
  );
}
