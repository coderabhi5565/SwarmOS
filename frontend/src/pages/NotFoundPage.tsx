import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="space-y-2 py-12 text-center">
      <p className="font-mono text-sm text-brand-cyan">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link className="text-primary hover:underline" to="/app">
        Back to overview
      </Link>
    </div>
  );
}
