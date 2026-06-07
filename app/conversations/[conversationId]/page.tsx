import Link from "next/link";
import { notFound } from "next/navigation";
import { getConversationById } from "@/lib/repository";

export const dynamic = "force-dynamic";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === "sent") {
    return "tag success";
  }

  if (status === "failed") {
    return "tag danger";
  }

  if (status === "processing" || status === "sending" || status === "queued") {
    return "tag warning";
  }

  return "tag";
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const conversation = await getConversationById(conversationId);

  if (!conversation) {
    notFound();
  }

  return (
    <main>
      <Link className="breadcrumb" href="/">
        ← Back to conversations
      </Link>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h1 className="page-title" style={{ fontSize: "1.8rem" }}>
              {conversation.fromPhone}
            </h1>
            <div className="small">To {conversation.toPhone}</div>
          </div>
          <div className="small">Updated {formatDate(conversation.updatedAt)}</div>
        </div>
        <div className="panel-body">
          <div className="message-thread">
            {conversation.messages.map((message) => (
              <article key={message.id} className={`message ${message.direction}`}>
                <div className="row">
                  <strong>{message.direction}</strong>
                  <span className={statusClass(message.status)}>{message.status}</span>
                </div>
                <div className="message-body">{message.body}</div>
                <div className="small">
                  {formatDate(message.createdAt)}
                  {message.error ? ` · ${message.error}` : ""}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
