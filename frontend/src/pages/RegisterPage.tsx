import { Loader2, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { emailProblem, MIN_PASSWORD, nameProblem, passwordProblem, phoneProblem, safeNext, useRegister } from "@/api/auth";
import { AuthCard, EphemeralNote, Field, FormError } from "@/components/auth/AuthForm";
import { Button } from "@/components/ui/button";

/** Create an account (and sign in): name, email, phone and password. */
export function RegisterPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const register = useRegister();
  const [form, setForm] = useState({ full_name: "", email: "", phone: "", password: "" });
  const [submitted, setSubmitted] = useState(false);

  const problems = {
    full_name: nameProblem(form.full_name),
    email: emailProblem(form.email),
    phone: phoneProblem(form.phone),
    password: passwordProblem(form.password),
  };
  const valid = Object.values(problems).every((problem) => problem === null);
  const shown = (field: keyof typeof problems) => (submitted ? problems[field] : null);
  const update = (field: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!valid || register.isPending) return;
    register.mutate(
      { full_name: form.full_name.trim(), email: form.email.trim(), phone: form.phone.trim(), password: form.password },
      { onSuccess: () => navigate(next, { replace: true }) },
    );
  }

  return (
    <AuthCard eyebrow="Account" title="Create an account">
      <form noValidate onSubmit={submit} className="space-y-4" aria-label="Register">
        <Field label="Full name" name="full_name" autoComplete="name" value={form.full_name} onChange={update("full_name")} problem={shown("full_name")} />
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={update("email")}
          problem={shown("email")}
        />
        <Field
          label="Phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          value={form.phone}
          onChange={update("phone")}
          problem={shown("phone")}
          hint="10 to 15 digits, optionally starting with +. Only its last four digits are ever shown."
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={update("password")}
          problem={shown("password")}
          hint={`At least ${MIN_PASSWORD} characters.`}
        />
        <FormError error={register.error} action="register" />
        <Button type="submit" size="lg" className="w-full" disabled={register.isPending}>
          {register.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <UserPlus aria-hidden="true" />}
          {register.isPending ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        Already registered?{" "}
        <Link className="text-primary hover:underline" to={`/login?next=${encodeURIComponent(next)}`}>
          Sign in
        </Link>
      </p>
      <EphemeralNote />
    </AuthCard>
  );
}
