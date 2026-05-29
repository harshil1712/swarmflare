import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { MCPServersState } from "agents";
import { Badge, Button, InputArea, Switch, Text } from "@cloudflare/kumo";
import { useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  BrainIcon,
  BugIcon,
  CircleIcon,
  ImageIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  PlugsConnectedIcon,
  StopIcon,
  TrashIcon,
  WrenchIcon,
  XIcon
} from "@phosphor-icons/react";
import type { ChatAgent } from "../server";
import type { SwarmState } from "../swarm/types";
import { SwarmLaunchpad } from "../swarm/ui/launchpad";
import type { SwarmInspection } from "../swarm/ui/types";
import { SwarmWorkspace } from "../swarm/ui/workspace";
import { McpPanel } from "../mcp/mcp-panel";
import { ThemeToggle } from "../ui/theme-toggle";
import {
  ACCEPTED_IMAGE_MIME_TYPES,
  createValidImageAttachments,
  fileToDataUri,
  type Attachment
} from "./attachments";
import { MessageList } from "./message-parts";

export function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toasts = useKumoToastManager();
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [swarmState, setSwarmState] = useState<SwarmState>();
  const [selectedSwarmRunId, setSelectedSwarmRunId] = useState<string>();
  const [selectedWorkUnitId, setSelectedWorkUnitId] = useState<string>();
  const [swarmInspection, setSwarmInspection] = useState<SwarmInspection>();
  const [isInspectingSwarm, setIsInspectingSwarm] = useState(false);
  const [inspectError, setInspectError] = useState<string>();
  const mcpPanelRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<ChatAgent, SwarmState>({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback((state: SwarmState) => {
      setSwarmState(state);
    }, []),
    onMcpUpdate: useCallback((state: MCPServersState) => {
      setMcpState(state);
    }, []),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "scheduled-task") {
            toasts.add({
              title: "Scheduled task completed",
              description: data.description,
              timeout: 0
            });
          }
        } catch {
          // Not JSON or not our event
        }
      },
      [toasts]
    )
  });

  useEffect(() => {
    if (!showMcpPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        mcpPanelRef.current &&
        !mcpPanelRef.current.contains(e.target as Node)
      ) {
        setShowMcpPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMcpPanel]);

  const handleAddServer = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setIsAddingServer(true);
    try {
      await agent.stub.addServer(mcpName.trim(), mcpUrl.trim());
      setMcpName("");
      setMcpUrl("");
    } catch (e) {
      console.error("Failed to add MCP server:", e);
    } finally {
      setIsAddingServer(false);
    }
  };

  const handleRemoveServer = async (serverId: string) => {
    try {
      await agent.stub.removeServer(serverId);
    } catch (e) {
      console.error("Failed to remove MCP server:", e);
    }
  };

  const mcpToolCount = mcpState.tools.length;

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    onToolCall: async (event) => {
      if (
        "addToolOutput" in event &&
        event.toolCall.toolName === "getUserTimezone"
      ) {
        event.addToolOutput({
          toolCallId: event.toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
  });

  const isStreaming = status === "streaming" || status === "submitted";
  const swarmRuns = Object.values(swarmState?.runs ?? {}).sort((a, b) =>
    (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
  );
  const selectedSwarmRun =
    (selectedSwarmRunId ? swarmState?.runs[selectedSwarmRunId] : undefined) ??
    (swarmState?.selectedRunId
      ? swarmState.runs[swarmState.selectedRunId]
      : undefined) ??
    swarmRuns[0];
  const hasSwarmRun = !!selectedSwarmRun && selectedSwarmRun.status !== "idle";
  const isSwarmActive =
    !!selectedSwarmRun &&
    ["planning", "running", "synthesizing"].includes(selectedSwarmRun.status);
  const hasSynthesis = !!selectedSwarmRun?.synthesis?.markdown;

  const handleClear = useCallback(async () => {
    clearHistory();
    setSelectedSwarmRunId(undefined);
    setSelectedWorkUnitId(undefined);
    setSwarmInspection(undefined);
    setInspectError(undefined);

    try {
      await agent.stub.clearSwarms();
    } catch (error) {
      console.error("Failed to clear swarms:", error);
    }
  }, [agent, clearHistory]);

  const handleCancelSwarm = useCallback(
    async (runId: string) => {
      try {
        await agent.stub.cancelSwarm(runId);
      } catch (e) {
        console.error("Failed to cancel swarm:", e);
      }
    },
    [agent]
  );

  const handleSelectSwarmRun = useCallback((runId: string) => {
    setSelectedSwarmRunId(runId);
    setSelectedWorkUnitId(undefined);
    setSwarmInspection(undefined);
    setInspectError(undefined);
  }, []);

  const handleInspectWorkUnit = useCallback(
    async (workUnitId: string) => {
      const runId = selectedSwarmRunId ?? swarmState?.selectedRunId;
      if (!runId) return;
      setSelectedWorkUnitId(workUnitId);
      setIsInspectingSwarm(true);
      setInspectError(undefined);
      try {
        setSwarmInspection(await agent.stub.inspectSwarm(runId));
      } catch (error) {
        setInspectError(
          error instanceof Error ? error.message : "Failed to inspect swarm"
        );
      } finally {
        setIsInspectingSwarm(false);
      }
    },
    [agent, selectedSwarmRunId, swarmState?.selectedRunId]
  );

  useEffect(() => {
    const runs = swarmState?.runs ?? {};
    if (selectedSwarmRunId && runs[selectedSwarmRunId]) return;

    const nextRunId =
      swarmState?.selectedRunId && runs[swarmState.selectedRunId]
        ? swarmState.selectedRunId
        : Object.values(runs).sort((a, b) =>
            (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
          )[0]?.runId;

    if (nextRunId) setSelectedSwarmRunId(nextRunId);
  }, [selectedSwarmRunId, swarmState]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const result = createValidImageAttachments(files, attachments);

      if (result.errors.length > 0) {
        toasts.add({
          title: "Some images were not attached",
          description: result.errors.join(" ")
        });
      }

      if (result.attachments.length > 0) {
        setAttachments((prev) => [...prev, ...result.attachments]);
      }
    },
    [attachments, toasts]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att) URL.revokeObjectURL(att.preview);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles]
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isStreaming) return;
    setInput("");

    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; mediaType: string; url: string }
    > = [];
    if (text) parts.push({ type: "text", text });

    for (const att of attachments) {
      const dataUri = await fileToDataUri(att.file);
      parts.push({ type: "file", mediaType: att.mediaType, url: dataUri });
    }

    for (const att of attachments) URL.revokeObjectURL(att.preview);
    setAttachments([]);

    sendMessage({ role: "user", parts });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, attachments, isStreaming, sendMessage]);

  const startPrompt = useCallback(
    (prompt: string) => {
      if (isStreaming) return;
      sendMessage({ role: "user", parts: [{ type: "text", text: prompt }] });
    },
    [isStreaming, sendMessage]
  );

  return (
    <div
      className="swarm-shell flex flex-col h-screen bg-kumo-elevated relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-kumo-elevated/80 backdrop-blur-sm border-2 border-dashed border-kumo-brand rounded-xl m-2 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-kumo-brand">
            <ImageIcon size={40} />
            <Text variant="heading3" as="span">
              Drop images here
            </Text>
          </div>
        </div>
      )}

      <header className="swarm-header px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="swarm-logo" aria-hidden="true">
              <BrainIcon size={18} weight="fill" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-kumo-default">
                Swarmflare
              </h1>
              <div className="text-xs text-kumo-subtle">
                Parallel agents for broad goals
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <div className="relative" ref={mcpPanelRef}>
              <Button
                variant="secondary"
                icon={<PlugsConnectedIcon size={16} />}
                onClick={() => setShowMcpPanel(!showMcpPanel)}
              >
                MCP
                {mcpToolCount > 0 && (
                  <Badge variant="primary" className="ml-1.5">
                    <WrenchIcon size={10} className="mr-0.5" />
                    {mcpToolCount}
                  </Badge>
                )}
              </Button>

              {showMcpPanel && (
                <McpPanel
                  mcpState={mcpState}
                  mcpName={mcpName}
                  mcpUrl={mcpUrl}
                  isAddingServer={isAddingServer}
                  onNameChange={setMcpName}
                  onUrlChange={setMcpUrl}
                  onAddServer={handleAddServer}
                  onRemoveServer={handleRemoveServer}
                  onClose={() => setShowMcpPanel(false)}
                />
              )}
            </div>
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={handleClear}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      <div
        className={`swarm-app-layout flex-1 min-h-0 overflow-hidden ${isSwarmActive ? "is-running" : ""} ${hasSynthesis ? "is-complete" : ""}`}
      >
        <div className="conversation-pane min-h-0 overflow-y-auto">
          <div className="conversation-content px-5 py-6 space-y-5">
            {messages.length === 0 && !hasSwarmRun && (
              <SwarmLaunchpad onPrompt={startPrompt} />
            )}

            <MessageList
              messages={messages}
              showDebug={showDebug}
              isStreaming={isStreaming}
              addToolApprovalResponse={addToolApprovalResponse}
            />

            <div ref={messagesEndRef} />
          </div>
        </div>

        {hasSwarmRun && (
          <SwarmWorkspace
            run={selectedSwarmRun}
            runs={swarmRuns}
            selectedWorkUnitId={selectedWorkUnitId}
            inspection={swarmInspection}
            inspectError={inspectError}
            isInspecting={isInspectingSwarm}
            onSelectRun={handleSelectSwarmRun}
            onCancel={handleCancelSwarm}
            onInspectWorkUnit={handleInspectWorkUnit}
          />
        )}
      </div>

      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_IMAGE_MIME_TYPES.join(",")}
            aria-label="Upload image attachments"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {attachments.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="relative group rounded-lg border border-kumo-line bg-kumo-control overflow-hidden"
                >
                  <img
                    src={att.preview}
                    alt={att.file.name}
                    className="h-16 w-16 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="absolute top-0.5 right-0.5 rounded-full bg-kumo-contrast/80 text-kumo-inverse p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={`Remove ${att.file.name}`}
                  >
                    <XIcon size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <Button
              type="button"
              variant="ghost"
              shape="square"
              aria-label="Attach images"
              icon={<PaperclipIcon size={18} />}
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || isStreaming}
              className="mb-0.5"
            />
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              onPaste={handlePaste}
              placeholder={
                attachments.length > 0
                  ? "Add a message or send images..."
                  : "Send a message..."
              }
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={
                  (!input.trim() && attachments.length === 0) || !connected
                }
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
