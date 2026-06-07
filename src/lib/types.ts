export type MessageDirection = "inbound" | "outbound";

export type MessageStatus =
  | "received"
  | "processing"
  | "sent"
  | "failed"
  | "queued"
  | "sending";

export type JobStatus = "pending" | "running" | "completed" | "failed";

export type ConversationSummary = {
  id: string;
  fromPhone: string;
  toPhone: string;
  lastMessageAt: string;
  lastMessageBody: string | null;
  lastMessageStatus: MessageStatus | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MessageRecord = {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  externalId: string;
  body: string;
  status: MessageStatus;
  error: string | null;
  relatedInboundMessageId: string | null;
  providerMessageId: string | null;
  receivedAt: string;
  processingStartedAt: string | null;
  processedAt: string | null;
  sentAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationDetails = {
  id: string;
  fromPhone: string;
  toPhone: string;
  createdAt: string;
  updatedAt: string;
  messages: MessageRecord[];
};
