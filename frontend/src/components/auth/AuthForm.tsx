import { Database } from "lucide-react";
import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { ApiError } from "@/api/client";
import { cn } from "@/lib/utils";

/** The glass card the sign-in and registration forms sit in. */
export function AuthCard({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md py-6 sm:py-10">
      <div className="glass space-y-6 rounded-2xl p-6 sm:p-8">
        <header className="space-y-1">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">{eyebrow}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * A labelled input with its problem, if any, linked for assistive
 * technology. The problem shows once the field has been submitted.
 */
export function Field({
  label,
  problem,
  hint,
  ...input
}: { label: string; problem?: string | null; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const described = problem ? `${id}-problem` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={problem ? true : undefined}
        aria-describedby={described}
        className={cn(
          "h-10 w-full rounded-md border bg-background/60 px-3 text-sm outline-none transition-colors",
          "placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring",
          problem ? "border-status-failed/70" : "border-border/70",
        )}
        {...input}
      />
      {problem ? (
        <p id={`${id}-problem`} className="text-xs text-status-failed">
          {problem}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** What the server said about a sign-in or registration, in plain words. */
export function FormError({ error, action }: { error: Error | null; action: "sign in" | "register" }) {
  if (!error) return null;
  let message: string;
  if (error instanceof ApiError) {
    if (error.status === 429) {
      message = error.retryAfter
        ? `Too many attempts from this connection. Try again in ${Math.ceil(error.retryAfter / 60)} min.`
        : "Too many attempts from this connection. Try again later.";
    } else if (error.status === 401 || error.status === 409 || error.status === 422) {
      message = sentence(error.message);
    } else {
      message = `Could not ${action} (${error.message}).`;
    }
  } else {
    message = `Could not reach the server, so could not ${action}. A sleeping free-tier backend can take up to a minute to wake; try again shortly.`;
  }
  return (
    <p role="alert" className="rounded-md border border-status-failed/40 bg-status-failed/10 px-3 py-2 text-sm text-status-failed">
      {message}
    </p>
  );
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "Something was not accepted.";
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** Accounts live in the demo's SQLite file, which a free-tier restart wipes. */
export function EphemeralNote() {
  return (
    <p role="note" className="flex gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
      <Database aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Accounts are kept in this demo&apos;s ephemeral SQLite database: a free-tier restart deletes them, and you may need
        to register again. Use a password you do not use anywhere else.
      </span>
    </p>
  );
}
