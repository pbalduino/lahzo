"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type FormState = {
  from: string;
  to: string;
  body: string;
};

export function MockSmsForm() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({
    from: "",
    to: "",
    body: "Hello from the assessment demo.",
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/dev/inbound", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Failed to submit mock SMS");
      }

      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unexpected error");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <strong>Send test SMS</strong>
        <span className="small">Creates an inbound event and sends the async reply</span>
      </div>
      <div className="panel-body">
        <form className="form-grid" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="from">From</label>
            <input
              id="from"
              placeholder="+15013659142"
              required
              value={form.from}
              onChange={(event) => setForm((current) => ({ ...current, from: event.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="to">To</label>
            <input
              id="to"
              placeholder="+5511975185804"
              required
              value={form.to}
              onChange={(event) => setForm((current) => ({ ...current, to: event.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="body">Body</label>
            <textarea
              id="body"
              value={form.body}
              onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
            />
          </div>
          <button className="button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Sending..." : "Send test SMS"}
          </button>
          {error ? <div className="tag danger">{error}</div> : null}
        </form>
      </div>
    </section>
  );
}
