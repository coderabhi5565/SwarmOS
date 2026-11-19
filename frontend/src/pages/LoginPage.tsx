import { Loader2, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { safeNext, useLogin } from "@/api/auth";
import { AuthCard, Field, FormError } from "@/components/auth/AuthForm";
import { Button } from "@/components/ui/button";

/** Sign in with an email address or a phone number, and a password. */
export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const login = useLogin();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const problems = {
    identifier: identifier.trim() ? null : "Enter your email or phone number.",
    password: password ? null : "Enter your password.",
  };
  const valid = !problems.identifier && !problems.password;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!valid || login.isPending) return;
    login.mutate({ identifier: identifier.trim(), password }, { onSuccess: () => navigate(next, { replace: true }) });
  }

  return (
    <AuthCard eyebrow="Account" title="Sign in">
      <form noValidate onSubmit={submit} className="space-y-4" aria-label="Sign in">
        <Field
          label="Email or phone"
          name="identifier"
          autoComplete="username"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          problem={submitted ? problems.identifier : null}
          hint="The email address or phone number you registered with."
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          problem={submitted ? problems.password : null}
        />
        <FormError error={login.error} action="sign in" />
        <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
          {login.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <LogIn aria-hidden="true" />}
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        No account yet?{" "}
        <Link className="text-primary hover:underline" to={`/register?next=${encodeURIComponent(next)}`}>
          Register
        </Link>
      </p>
    </AuthCard>
  );
}
