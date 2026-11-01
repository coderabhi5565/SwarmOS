import { Menu } from "lucide-react";
import * as m from "motion/react-m";
import { NavLink, Outlet, useLocation, useMatches } from "react-router";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { BackendStatus } from "./BackendStatus";

export const NAV_ITEMS = [
  { to: "/", label: "Overview", end: true },
  { to: "/console", label: "Console", end: false },
] as const;

const REPOSITORY_URL = "https://github.com/coderabhi5565/SwarmOS";

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return NAV_ITEMS.map((item) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "rounded-md px-3 py-1.5 text-sm transition-colors",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )
      }
    >
      {item.label}
    </NavLink>
  ));
}

function Brand() {
  return (
    <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span
        aria-hidden="true"
        className="size-6 rounded-md bg-gradient-to-br from-brand-cyan via-primary to-brand-violet shadow-[0_0_18px_-4px_var(--brand-cyan)]"
      />
      <span>SwarmOS</span>
    </NavLink>
  );
}

/** Route handle: render the page edge to edge instead of in the content column. */
export interface RouteHandle {
  fullBleed?: boolean;
}

export function AppShell() {
  const location = useLocation();
  const fullBleed = useMatches().some((match) => (match.handle as RouteHandle | undefined)?.fullBleed);

  return (
    <div className="relative flex min-h-dvh flex-col">
      {/* Backdrop glow: decorative only, behind everything. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(900px_500px_at_85%_-10%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent_60%),radial-gradient(700px_420px_at_0%_0%,color-mix(in_oklch,var(--brand-violet)_10%,transparent),transparent_55%)]"
      />

      <header className="glass sticky top-0 z-40 border-x-0 border-t-0">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Brand />
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            <NavItems />
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <BackendStatus className="hidden sm:inline-flex" />
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden text-sm text-muted-foreground hover:text-foreground md:inline"
            >
              GitHub
            </a>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-64">
                <SheetHeader>
                  <SheetTitle>SwarmOS</SheetTitle>
                </SheetHeader>
                <nav aria-label="Main" className="flex flex-col gap-1 px-4">
                  <NavItems />
                  <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-sm text-muted-foreground">
                    GitHub
                  </a>
                </nav>
                <BackendStatus className="mx-4 mt-4 self-start" />
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <m.main
        key={location.pathname}
        id="main"
        className={cn("flex-1", !fullBleed && "mx-auto w-full max-w-7xl px-4 py-6 sm:px-6")}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <Outlet />
      </m.main>
    </div>
  );
}
