import type { Agent } from "@mariozechner/pi-agent-core";

export type AgentStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; tool: string; args?: string }
  | { type: "tool_end"; tool: string; result?: string }
  | { type: "thinking_delta"; delta: string };

/**
 * Subscribe to a pi-agent-core Agent's events and emit structured stream events.
 * Also accumulates the full text response and returns it via the result callback.
 *
 * Returns a function that resolves to the accumulated text.
 */
export function subscribeWithStreaming(
  agent: Agent,
  onEvent?: (event: AgentStreamEvent) => void,
): { getResult: () => string } {
  let result = "";
  const activeCalls = new Map<string, string>(); // toolCallId → toolName

  agent.subscribe((event: any) => {
    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      if (!e) return;

      if (e.type === "text_delta") {
        result += e.delta;
        onEvent?.({ type: "text_delta", delta: e.delta });
      } else if (e.type === "thinking_delta") {
        onEvent?.({ type: "thinking_delta", delta: e.delta });
      } else if (e.type === "toolcall_start") {
        // Capture tool name from the partial message content
        const msg = event.message;
        if (msg?.content) {
          const tc = msg.content.find((c: any) => c.type === "toolCall" && !activeCalls.has(c.id));
          if (tc) {
            activeCalls.set(tc.id, tc.name);
          }
        }
      } else if (e.type === "toolcall_end" && e.toolCall) {
        const name = e.toolCall.name ?? "unknown";
        const args = e.toolCall.arguments
          ? JSON.stringify(e.toolCall.arguments).slice(0, 200)
          : undefined;
        onEvent?.({ type: "tool_start", tool: name, args });
      }
    } else if (event.type === "tool_execution_end") {
      const name = activeCalls.get(event.toolCallId) ?? event.toolCallId;
      const resultText = event.result?.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("")
        .slice(0, 150);
      onEvent?.({ type: "tool_end", tool: name, result: resultText });
      activeCalls.delete(event.toolCallId);
    }
  });

  return { getResult: () => result };
}
