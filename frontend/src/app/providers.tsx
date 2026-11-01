import { QueryClientProvider } from "@tanstack/react-query";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import { useState, type ReactNode } from "react";
import { createQueryClient } from "@/api/queryClient";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: ReactNode }) {
  // One client per mounted app (tests mount their own).
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      {/* LazyMotion + the `m` component ship only the DOM animation features;
          strict makes an accidental full `motion.*` import throw. "user":
          animations follow the OS reduced-motion setting. */}
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </MotionConfig>
      </LazyMotion>
    </QueryClientProvider>
  );
}
