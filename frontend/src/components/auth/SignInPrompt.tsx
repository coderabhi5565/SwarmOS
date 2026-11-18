import { LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useReturnPath } from "./AccountControls";

/**
 * In place of a form a visitor may not use: why, and the way in. The
 * server enforces the same rule; this only saves a refused request.
 */
export function SignInPrompt({
  title,
  children,
  className,
  signIn = true,
}: {
  title: string;
  children?: ReactNode;
  className?: string;
  /** Offer sign-in and registration (false when signing in would not help). */
  signIn?: boolean;
}) {
  const next = encodeURIComponent(useReturnPath());
  return (
    <section
      aria-label={title}
      className={cn("glass flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl px-4 py-3", className)}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        {children && <p className="text-sm text-muted-foreground">{children}</p>}
      </div>
      {signIn && (
        <div className="flex items-center gap-2">
          <Button asChild size="sm">
            <Link to={`/login?next=${next}`}>
              <LogIn aria-hidden="true" />
              Sign in
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/register?next=${next}`}>Register</Link>
          </Button>
        </div>
      )}
    </section>
  );
}
