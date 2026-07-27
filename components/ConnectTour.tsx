"use client";

// ConnectTour - the guided setup a first-time visitor sees, and the only way into the app
// until a warehouse is linked. Four steps: what Scout is about to do, where to find the
// connection details, the form itself (tested live against the real server), and a
// confirmation that names what it found. Once linked, the cookie makes it stick, so this
// only reappears if the user disconnects - or opens it deliberately from Settings.

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PropertySearchIcon } from "@hugeicons/core-free-icons";
import type { ConnectionForm, ConnectionInfo } from "@/hooks/useConnection";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CloseIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  GraphIcon,
  PaperclipIcon,
  ShieldIcon,
  SparkIcon,
  SpinnerIcon,
} from "./icons";

const CLICKHOUSE_CLOUD_URL = "https://clickhouse.com/cloud";

const STEPS = ["Welcome", "Details", "Connect", "Ready"] as const;

const EMPTY_FORM: ConnectionForm = { host: "", username: "default", password: "", database: "default" };

export default function ConnectTour({
  info,
  onConnect,
  onClose,
  dismissible,
  initialStep = 0,
}: {
  info: ConnectionInfo | null;
  onConnect: (form: ConnectionForm) => Promise<{ ok: boolean; error?: string }>;
  /** Close the tour. Always available to the final step's "Start exploring". */
  onClose: () => void;
  /** Whether Esc and the ✕ work - false during first-run onboarding, where there is no app
   *  behind the overlay to go back to. */
  dismissible: boolean;
  /** Where to open: 0 for onboarding, 2 (the form) when re-linking from Settings. */
  initialStep?: number;
}) {
  const [step, setStep] = useState(initialStep);
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLInputElement>(null);

  // Focus the first field the moment the form appears - the step exists to be typed into.
  useEffect(() => {
    if (step === 2) hostRef.current?.focus();
  }, [step]);

  // Esc closes the tour only when there's an app behind it.
  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismissible, onClose]);

  const set = (k: keyof ConnectionForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (testing || !form.host.trim()) return;
    setTesting(true);
    setError(null);
    const res = await onConnect(form);
    setTesting(false);
    if (res.ok) {
      setForm((f) => ({ ...f, password: "" })); // don't keep the secret in component state
      setStep(3);
    } else {
      setError(res.error ?? "Connection failed");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-6">
      <div className="absolute inset-0 bg-slate-900/25 backdrop-blur-md dark:bg-black/55" />

      <div className="glass-chrome-opaque relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-3xl shadow-2xl animate-fade-up">
        {/* header: identity + progress */}
        <div className="flex shrink-0 items-center gap-3 border-b border-line/60 px-6 py-4">
          <HugeiconsIcon icon={PropertySearchIcon} size={26} className="shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold leading-none tracking-tight text-ink">Scout setup</div>
            <div className="mt-1 text-[11px] font-medium text-ink-faint">
              Step {step + 1} of {STEPS.length} &middot; {STEPS[step]}
            </div>
          </div>
          <div className="flex items-center gap-1.5" aria-hidden>
            {STEPS.map((s, i) => (
              <span
                key={s}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === step ? "w-5 bg-brand" : i < step ? "w-1.5 bg-brand/45" : "w-1.5 bg-ink-faint/25"
                }`}
              />
            ))}
          </div>
          {dismissible && (
            <button
              onClick={onClose}
              title="Close"
              className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {step === 0 && <WelcomeStep />}
          {step === 1 && <DetailsStep />}
          {step === 2 && (
            <FormStep
              form={form}
              set={set}
              hostRef={hostRef}
              showPassword={showPassword}
              onTogglePassword={() => setShowPassword((v) => !v)}
              onSubmit={submit}
              testing={testing}
              error={error}
            />
          )}
          {step === 3 && <ReadyStep info={info} />}
        </div>

        {/* footer: navigation */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line/60 px-6 py-4">
          {step > 0 && step < 3 ? (
            <button
              onClick={() => {
                setError(null);
                setStep((s) => s - 1);
              }}
              disabled={testing}
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              Back
            </button>
          ) : (
            <span />
          )}

          {step === 0 && <PrimaryButton onClick={() => setStep(1)}>Get started<ArrowRightIcon className="h-4 w-4" /></PrimaryButton>}
          {step === 1 && <PrimaryButton onClick={() => setStep(2)}>I have my details<ArrowRightIcon className="h-4 w-4" /></PrimaryButton>}
          {step === 2 && (
            <PrimaryButton onClick={submit} disabled={testing || !form.host.trim()}>
              {testing ? (
                <>
                  <SpinnerIcon className="h-4 w-4 animate-spin" />
                  Testing connection…
                </>
              ) : (
                <>
                  Test &amp; connect
                  <ArrowRightIcon className="h-4 w-4" />
                </>
              )}
            </PrimaryButton>
          )}
          {step === 3 && (
            <PrimaryButton onClick={onClose}>
              Start exploring
              <ArrowRightIcon className="h-4 w-4" />
            </PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[21px] font-extrabold leading-tight tracking-tight text-ink">
          Point Scout at your ClickHouse
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
          Scout is an analyst that works directly on your warehouse. Link a database and it maps the
          schema, recovers how the tables join, writes the SQL, and answers in dashboards.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        <Assurance icon={DatabaseIcon} title="Your data stays where it is">
          Scout queries your warehouse in place. Nothing is copied out or stored on our side.
        </Assurance>
        <Assurance icon={ShieldIcon} title="Read-only by design">
          The agent can only run <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[11px] dark:bg-white/10">SELECT</code>.
          Writes and DDL are refused before the query leaves, and blocked again at the server.
        </Assurance>
        <Assurance icon={SparkIcon} title="Linked once, remembered">
          Your credentials are encrypted into a cookie only this server can open, and stay put until
          you disconnect.
        </Assurance>
      </div>

      <a
        href={CLICKHOUSE_CLOUD_URL}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1.5 self-start text-[12.5px] font-semibold text-brand transition-opacity hover:opacity-80"
      >
        Don&apos;t have one yet? Start a free ClickHouse Cloud service
        <ExternalLinkIcon className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

function DetailsStep() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[21px] font-extrabold leading-tight tracking-tight text-ink">
          Where to find your details
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
          Scout connects over ClickHouse&apos;s HTTPS interface, so you need four things: host,
          username, password, and the database to explore.
        </p>
      </div>

      <div className="rounded-2xl border border-line bg-black/[0.02] p-4 dark:bg-white/[0.03]">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">ClickHouse Cloud</div>
        <ol className="mt-3 flex flex-col gap-2.5">
          <NumberedStep n={1}>Open your service in the ClickHouse Cloud console.</NumberedStep>
          <NumberedStep n={2}>
            Click <strong className="font-semibold text-ink">Connect</strong>, then pick{" "}
            <strong className="font-semibold text-ink">HTTPS</strong>.
          </NumberedStep>
          <NumberedStep n={3}>
            Copy the host shown there (it ends in <span className="font-mono text-[12px]">.clickhouse.cloud</span>),
            along with the username and password.
          </NumberedStep>
        </ol>
      </div>

      <div className="rounded-2xl border border-line bg-black/[0.02] p-4 dark:bg-white/[0.03]">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Self-hosted</div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
          Use your HTTP interface: port <span className="font-mono text-[12px]">8123</span> plain, or{" "}
          <span className="font-mono text-[12px]">8443</span> with TLS. The endpoint has to be reachable
          from wherever Scout is running.
        </p>
      </div>

      <div className="flex items-start gap-2.5 rounded-2xl border border-brand/25 bg-brand-50/60 p-3.5 dark:bg-brand-950/20">
        <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <p className="text-[12.5px] leading-relaxed text-ink-soft">
          A <strong className="font-semibold text-ink">read-only user is enough</strong> to ask questions.
          Grant that same user <span className="font-mono text-[11.5px]">CREATE TABLE</span> and{" "}
          <span className="font-mono text-[11.5px]">INSERT</span> only if you also want to attach files.
        </p>
      </div>
    </div>
  );
}

function FormStep({
  form,
  set,
  hostRef,
  showPassword,
  onTogglePassword,
  onSubmit,
  testing,
  error,
}: {
  form: ConnectionForm;
  set: (k: keyof ConnectionForm) => (e: React.ChangeEvent<HTMLInputElement>) => void;
  hostRef: React.RefObject<HTMLInputElement | null>;
  showPassword: boolean;
  onTogglePassword: () => void;
  onSubmit: () => void;
  testing: boolean;
  error: string | null;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[21px] font-extrabold leading-tight tracking-tight text-ink">
          Your connection
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
          Scout runs one <span className="font-mono text-[12.5px]">SELECT version()</span> to check these
          work before saving anything.
        </p>
      </div>

      <Field label="Host" hint="Paste it bare or as a full URL - https:// and :8443 are filled in for you.">
        <input
          ref={hostRef}
          value={form.host}
          onChange={set("host")}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="abc123.ap-south-1.aws.clickhouse.cloud:8443"
          className={INPUT_CLASS}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Username">
          <input
            value={form.username}
            onChange={set("username")}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="default"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Database">
          <input
            value={form.database}
            onChange={set("database")}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="default"
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      <Field label="Password">
        <div className="relative">
          <input
            type={showPassword ? "text" : "password"}
            value={form.password}
            onChange={set("password")}
            onKeyDown={onKeyDown}
            autoComplete="off"
            placeholder="••••••••••••"
            className={`${INPUT_CLASS} pr-11`}
          />
          <button
            type="button"
            onClick={onTogglePassword}
            title={showPassword ? "Hide password" : "Show password"}
            className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-black/5 hover:text-ink-soft dark:hover:bg-white/10"
          >
            {showPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
          </button>
        </div>
      </Field>

      {error && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-red-500/30 bg-red-500/[0.07] p-3.5 animate-fade-up">
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-[10px] font-bold text-red-500">
            !
          </span>
          <p className="text-[12.5px] leading-relaxed text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {testing && (
        <p className="text-[12px] text-ink-faint">
          A ClickHouse Cloud service that has been idle can take a few seconds to wake up.
        </p>
      )}
    </div>
  );
}

function ReadyStep({ info }: { info: ConnectionInfo | null }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3.5">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="h-4.5 w-4.5" />
        </span>
        <div>
          <h2 className="text-[21px] font-extrabold leading-tight tracking-tight text-ink">
            Connected to {info?.database ?? "your database"}
          </h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-soft">
            {typeof info?.tables === "number"
              ? info.tables > 0
                ? `Scout found ${info.tables} table${info.tables === 1 ? "" : "s"} and has mapped the schema.`
                : "That database is empty for now — attach a file below to give Scout something to read."
              : "Scout has mapped the schema."}
          </p>
        </div>
      </div>

      <dl className="flex flex-col gap-px overflow-hidden rounded-2xl border border-line bg-line/60">
        <SummaryRow label="Host" value={info?.host ?? "—"} mono />
        <SummaryRow label="Database" value={info?.database ?? "—"} mono />
        <SummaryRow label="User" value={info?.username ?? "—"} mono />
        {info?.version && <SummaryRow label="Server" value={`ClickHouse ${info.version}`} />}
      </dl>

      <div className="flex flex-col gap-2.5">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">What you can do now</div>
        <Assurance icon={SparkIcon} title="Ask anything">
          Plain English. Scout plans the analysis, runs the SQL, and builds the dashboard.
        </Assurance>
        <Assurance icon={PaperclipIcon} title="Attach what isn't in there yet">
          The paperclip in the composer loads a CSV, Excel or JSON file in as a real table, joinable
          with the rest.
        </Assurance>
        <Assurance icon={GraphIcon} title="Check the joins">
          The Graph RAG Lab shows every join key Scout recovered, and lets you declare the ones
          naming conventions hid.
        </Assurance>
      </div>
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────────

const INPUT_CLASS =
  "field w-full rounded-xl px-3.5 py-2.5 text-[13.5px] text-ink outline-none transition-all " +
  "placeholder:text-ink-faint/70 focus:border-brand focus:ring-4 focus:ring-brand/20 dark:focus:ring-brand/35";

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-[13px] font-bold text-white shadow-sm transition-all hover:brightness-105 hover:shadow-md active:scale-[0.98] disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none dark:disabled:bg-zinc-800 dark:disabled:text-zinc-600"
    >
      {children}
    </button>
  );
}

function Assurance({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-line bg-black/[0.02] px-3.5 py-3 dark:bg-white/[0.03]">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand dark:bg-brand-950/40 dark:text-brand">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-bold text-ink">{title}</div>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-soft">{children}</p>
      </div>
    </div>
  );
}

function NumberedStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-white">
        {n}
      </span>
      <span className="text-[13px] leading-relaxed text-ink-soft">{children}</span>
    </li>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-relaxed text-ink-faint">{hint}</span>}
    </label>
  );
}

function SummaryRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 bg-canvas px-3.5 py-2.5">
      <dt className="text-[12px] font-semibold text-ink-faint">{label}</dt>
      <dd className={`min-w-0 truncate text-[12.5px] font-medium text-ink ${mono ? "font-mono text-[12px]" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
