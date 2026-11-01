import { Link } from "react-router";
import LegacyDashboard from "@/App";
import { useHealth } from "@/api/queries";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The pre-redesign dashboard (free-form goals, policy comparison, endpoint
 * probe), unchanged. It is a local-development tool: the public demo
 * refuses free-form runs, so there it explains itself instead.
 */
export function LegacyPage() {
  const health = useHealth();
  if (health.isPending) return <Skeleton className="m-6 h-40" />;
  if (health.data?.mode !== "local") {
    return (
      <div className="mx-auto max-w-xl space-y-2 px-4 py-12 text-center">
        <h1 className="text-xl font-semibold">Local development only</h1>
        <p className="text-sm text-muted-foreground">
          The legacy console runs free-form goals, which the public demo does not accept.{" "}
          <Link className="text-primary hover:underline" to="/runs/new">
            Start a catalog run
          </Link>{" "}
          instead.
        </p>
      </div>
    );
  }
  return (
    <div className="legacy-console">
      <LegacyDashboard />
    </div>
  );
}
