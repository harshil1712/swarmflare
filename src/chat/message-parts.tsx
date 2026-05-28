import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import { code } from "@streamdown/code";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  BrainIcon,
  CaretDownIcon,
  CheckCircleIcon,
  GearIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import { Streamdown } from "streamdown";

export function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.output, null, 2)}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <GearIcon size={14} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approval needed: {toolName}
            </Text>
          </div>
          <div className="font-mono mb-3">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: true });
                }
              }}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: false });
                }
              }}
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
            <Text size="xs" variant="secondary">
              Running {toolName}...
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  return null;
}

export function MessageList({
  messages,
  showDebug,
  isStreaming,
  addToolApprovalResponse
}: {
  messages: UIMessage[];
  showDebug: boolean;
  isStreaming: boolean;
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  return (
    <>
      {messages.map((message: UIMessage, index: number) => {
        const isUser = message.role === "user";
        const isLastAssistant =
          message.role === "assistant" && index === messages.length - 1;

        return (
          <div key={message.id} className="space-y-2">
            {showDebug && (
              <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                {JSON.stringify(message, null, 2)}
              </pre>
            )}

            {message.parts.filter(isToolUIPart).map((part) => (
              <ToolPartView
                key={part.toolCallId}
                part={part}
                addToolApprovalResponse={addToolApprovalResponse}
              />
            ))}

            {message.parts
              .filter(
                (part) =>
                  part.type === "reasoning" &&
                  (part as { text?: string }).text?.trim()
              )
              .map((part, i) => {
                const reasoning = part as {
                  type: "reasoning";
                  text: string;
                  state?: "streaming" | "done";
                };
                const isDone = reasoning.state === "done" || !isStreaming;
                return (
                  <div key={i} className="flex justify-start">
                    <details className="max-w-[85%] w-full" open={!isDone}>
                      <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                        <BrainIcon size={14} className="text-purple-400" />
                        <span className="font-medium text-kumo-default">
                          Reasoning
                        </span>
                        {isDone ? (
                          <span className="text-xs text-kumo-success">
                            Complete
                          </span>
                        ) : (
                          <span className="text-xs text-kumo-brand">
                            Thinking...
                          </span>
                        )}
                        <CaretDownIcon
                          size={14}
                          className="ml-auto text-kumo-inactive"
                        />
                      </summary>
                      <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                        {reasoning.text}
                      </pre>
                    </details>
                  </div>
                );
              })}

            {message.parts
              .filter(
                (part): part is Extract<typeof part, { type: "file" }> =>
                  part.type === "file" &&
                  (part as { mediaType?: string }).mediaType?.startsWith(
                    "image/"
                  ) === true
              )
              .map((part, i) => (
                <div
                  key={`file-${i}`}
                  className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                >
                  <img
                    src={part.url}
                    alt="Attachment"
                    className="max-h-64 rounded-xl border border-kumo-line object-contain"
                  />
                </div>
              ))}

            {message.parts
              .filter((part) => part.type === "text")
              .map((part, i) => {
                const text = (part as { type: "text"; text: string }).text;
                if (!text) return null;

                if (isUser) {
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                        {text}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                      <Streamdown
                        className="sd-theme rounded-2xl rounded-bl-md p-3"
                        plugins={{ code }}
                        controls={false}
                        isAnimating={isLastAssistant && isStreaming}
                      >
                        {text}
                      </Streamdown>
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </>
  );
}
