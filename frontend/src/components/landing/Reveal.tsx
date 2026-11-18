import { useReducedMotionConfig, useScroll } from "motion/react";
import * as m from "motion/react-m";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Content that rises into place the first time it scrolls into view.
 * Under reduced motion (the app's MotionConfig follows the OS setting) the
 * movement is dropped and the content simply appears.
 */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const shown = { opacity: 1, y: 0 };
  // Without IntersectionObserver nothing can say when it scrolls into view:
  // it enters on mount instead, so content is never left invisible.
  const entrance =
    typeof IntersectionObserver === "undefined"
      ? { animate: shown }
      : { whileInView: shown, viewport: { once: true, amount: 0.2 } };
  return (
    <m.div
      className={className}
      data-reveal=""
      initial={{ opacity: 0, y: 24 }}
      {...entrance}
      transition={{ duration: 0.45, ease: "easeOut", delay }}
    >
      {children}
    </m.div>
  );
}

/** A hairline under the header that fills as the page scrolls. Decorative; absent under reduced motion. */
export function ScrollProgress({ className }: { className?: string }) {
  const reduced = useReducedMotionConfig();
  const { scrollYProgress } = useScroll();
  if (reduced) return null;
  return (
    <m.div
      aria-hidden="true"
      data-testid="scroll-progress"
      className={cn("h-px origin-left bg-gradient-to-r from-brand-cyan to-brand-violet", className)}
      style={{ scaleX: scrollYProgress }}
    />
  );
}
