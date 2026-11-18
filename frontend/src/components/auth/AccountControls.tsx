import { LogIn, LogOut, ShieldCheck, UserRound } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { useLogout, useMe } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The current page, as a sign-in page's `next`, unless it is an account page. */
export function useReturnPath(): string {
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;
  return location.pathname === "/login" || location.pathname === "/register" ? "/runs/new" : here;
}

/**
 * The header's account area. Signed out: "Sign in" and "Register". Signed
 * in: the account's name and role, and "Sign out". Nothing while the first
 * answer is pending, so the header does not flash the wrong state.
 */
export function AccountControls({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const next = encodeURIComponent(useReturnPath());

  if (me.isPending) return null;

  if (!me.user) {
    return (
      <div role="group" aria-label="Account" className={cn("flex items-center gap-2", className)}>
        <Button asChild variant="ghost" size="sm">
          <Link to={`/login?next=${next}`} onClick={onNavigate}>
            <LogIn aria-hidden="true" />
            Sign in
          </Link>
        </Button>
        <Button asChild size="sm">
          <Link to={`/register?next=${next}`} onClick={onNavigate}>
            Register
          </Link>
        </Button>
      </div>
    );
  }

  const operator = me.user.role === "operator";
  const Icon = operator ? ShieldCheck : UserRound;
  return (
    <div role="group" aria-label="Account" className={cn("flex items-center gap-2", className)}>
      <span
        aria-label={`Signed in as ${me.user.full_name}, ${operator ? "Operator" : "User"}`}
        className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border border-border/70 bg-background/50 py-1 pr-1 pl-2.5 text-xs"
      >
        <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", operator ? "text-brand-violet" : "text-brand-cyan")} />
        <span className="truncate">{me.user.full_name}</span>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
            operator ? "bg-brand-violet/15 text-brand-violet" : "bg-brand-cyan/15 text-brand-cyan",
          )}
        >
          {operator ? "Operator" : "User"}
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={logout.isPending}
        onClick={() =>
          logout.mutate(undefined, {
            onSuccess: () => {
              onNavigate?.();
              navigate("/", { replace: true });
            },
          })
        }
      >
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
    </div>
  );
}
