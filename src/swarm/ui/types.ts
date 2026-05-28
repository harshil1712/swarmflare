import type { ChatAgent } from "../../server";

export type SwarmInspection = Awaited<ReturnType<ChatAgent["inspectSwarm"]>>;
