import type { PointerEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Whether the visitor asked for reduced motion (false where it cannot be asked). */
export function reducedMotionPreferred(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A glass card with a hairline border whose surface and border light up
 * under the pointer. The pointer's position is written to two CSS variables
 * on the card (--mouse-x, --mouse-y), which the two glow layers read, so
 * moving the pointer re-renders nothing. The glow is decorative: it appears
 * on hover only, is hidden from assistive technology, and neither follows
 * the pointer nor shows under reduced motion.
 */
export function SpotlightCard({ children, className }: { children: ReactNode; className?: string }) {
  function track(event: PointerEvent<HTMLElement>) {
    if (reducedMotionPreferred()) return;
    const card = event.currentTarget;
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mouse-x", `${Math.round(event.clientX - box.left)}px`);
    card.style.setProperty("--mouse-y", `${Math.round(event.clientY - box.top)}px`);
  }

  return (
    <article
      data-spotlight=""
      onPointerMove={track}
      className={cn(
        "group/spotlight relative isolate h-full overflow-hidden rounded-2xl border border-border/80 bg-card/60 backdrop-blur-md transition-colors hover:border-foreground/20",
        className,
      )}
    >
      {/* Border glow: a larger light, visible only through the 1px ring. */}
      <span
        aria-hidden="true"
        data-spotlight-layer="border"
        className="pointer-events-none absolute inset-0 -z-10 rounded-2xl opacity-0 transition-opacity duration-300 group-hover/spotlight:opacity-100 motion-reduce:hidden"
        style={{
          background:
            "radial-gradient(260px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), color-mix(in oklch, var(--brand-cyan) 55%, transparent), color-mix(in oklch, var(--brand-violet) 30%, transparent) 45%, transparent 70%)",
          padding: 1,
          mask: "linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)",
        }}
      />
      {/* Surface glow. */}
      <span
        aria-hidden="true"
        data-spotlight-layer="surface"
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover/spotlight:opacity-100 motion-reduce:hidden"
        style={{
          background:
            "radial-gradient(420px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), color-mix(in oklch, var(--brand-cyan) 9%, transparent), transparent 60%)",
        }}
      />
      {children}
    </article>
  );
}
