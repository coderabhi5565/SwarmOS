import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router";
import { Providers } from "@/app/providers";
import { createRouter } from "@/app/router";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@/styles/globals.css";
// The pre-redesign dashboard styles. Unlayered, so they still win over
// Tailwind's layers until each screen is ported.
import "./styles.css";

const router = createRouter();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </React.StrictMode>,
);
