import Link from "next/link";
import { env } from "@/lib/env";
import { getOperationalMetrics, listConversations } from "@/lib/repository";
import { MockSmsForm } from "@/components/mock-sms-form";

export const dynamic = "force-dynamic";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusTag(status: string | null) {
  if (!status) {
    return <span className="tag">idle</span>;
  }

  if (status === "sent") {
    return <span className="tag success">{status}</span>;
  }

  if (status === "failed") {
    return <span className="tag danger">{status}</span>;
  }

  if (status === "processing" || status === "sending" || status === "queued") {
    return <span className="tag warning">{status}</span>;
  }

  return <span className="tag">{status}</span>;
}

export default async function HomePage() {
  const [conversations, metrics] = await Promise.all([
    listConversations(),
    getOperationalMetrics(),
  ]);
  const showMockSmsForm = env.SMS_GATEWAY === "mock";

  return (
    <main>
      <div className="shell">
        <section className="stack">
          <header className="hero">
            <span className="tag">Lahzo SMS System</span>
            <h1>Asynchronous SMS conversations with durable processing.</h1>
            <p>
              Incoming webhooks are persisted immediately, queued in the database,
              and processed by an out-of-band worker before the reply is sent.
            </p>
          </header>

          {showMockSmsForm ? <MockSmsForm /> : null}

          <section className="panel">
            <div className="panel-header">
              <strong>Conversations</strong>
              <span className="small">{conversations.length} total</span>
            </div>
            <div className="panel-body">
              {conversations.length === 0 ? (
                <div className="empty-state">
                  {showMockSmsForm
                    ? "No conversations yet. Use the demo form above to create one."
                    : "No conversations yet. Send an SMS to the configured Twilio number to create one."}
                </div>
              ) : (
                <div className="conversation-list">
                  {conversations.map((conversation) => (
                    <Link
                      key={conversation.id}
                      className="conversation-card"
                      href={`/conversations/${conversation.id}`}
                    >
                      <div className="row">
                        <strong>{conversation.fromPhone}</strong>
                        {statusTag(conversation.lastMessageStatus)}
                      </div>
                      <div className="meta">To: {conversation.toPhone}</div>
                      <p style={{ margin: "10px 0 0" }}>
                        {conversation.lastMessageBody ?? "No messages yet"}
                      </p>
                      <div className="row" style={{ marginTop: 14 }}>
                        <span className="small">
                          {conversation.messageCount} message
                          {conversation.messageCount === 1 ? "" : "s"}
                        </span>
                        <span className="small">{formatDate(conversation.lastMessageAt)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
        </section>

        <aside className="stack">
          <section className="panel">
            <div className="panel-header">
              <strong>Operational Metrics</strong>
              <span className="small">
                {metrics.databaseOk ? "database ok" : "database issue"}
              </span>
            </div>
            <div className="panel-body">
              <div className="metrics">
                <div className="metric">
                  <div className="value">{metrics.counts.conversations}</div>
                  <div className="small">Conversations</div>
                </div>
                <div className="metric">
                  <div className="value">{metrics.counts.pendingJobs}</div>
                  <div className="small">Pending jobs</div>
                </div>
                <div className="metric">
                  <div className="value">{metrics.counts.failedJobs}</div>
                  <div className="small">Failed jobs</div>
                </div>
                <div className="metric">
                  <div className="value">{metrics.workerHealthy ? "up" : "stale"}</div>
                  <div className="small">Worker heartbeat</div>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <strong>Message Lifecycle</strong>
            </div>
            <div className="panel-body stack">
              <div>
                <span className="tag">received</span>
                <div className="small">Webhook persisted the inbound SMS.</div>
              </div>
              <div>
                <span className="tag warning">processing</span>
                <div className="small">Worker claimed the job and is simulating work.</div>
              </div>
              <div>
                <span className="tag success">sent</span>
                <div className="small">Outbound reply was recorded and sent via the gateway.</div>
              </div>
              <div className="small">
                Last inbound activity:{" "}
                {metrics.lastMessageAt ? formatDate(metrics.lastMessageAt) : "none yet"}
              </div>
              <div className="small">
                Worker heartbeat:{" "}
                {metrics.workerHeartbeatAt ? formatDate(metrics.workerHeartbeatAt) : "none yet"}
              </div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
