// src/inngest/functions.ts
import { inngest } from "./client";
import { createAgent, openai, type Message, type TextContent, type TextMessage } from "@inngest/agent-kit";
import { Sandbox } from "@e2b/code-interpreter";

function extractAssistantReply(messages: Message[]): string {
  return messages
    .filter((msg): msg is TextMessage => msg.type === "text" && msg.role === "assistant")
    .map((msg) => {
      if (typeof msg.content === "string") return msg.content;
      return msg.content
        .map((part: TextContent) => (part.type === "text" ? part.text : ""))
        .join("");
    })
    .join("\n");
}

function extractFencedCodeBlock(text: string, language?: string): string | null {
  const fenceRegex = /```(\w+)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    const lang = (match[1] ?? "").toLowerCase();
    const code = match[2]?.trim() ?? "";
    if (!code) continue;
    if (!language) return code;
    if (lang === language.toLowerCase()) return code;
  }

  return null;
}

const huggingFaceModel = openai({
  model: "mistralai/Mistral-7B-Instruct-v0.3",
  apiKey: process.env.HF_TOKEN!,
  baseUrl: "https://api-inference.huggingface.co/v1",
});

const myAgent = createAgent({
  name: "my-hf-agent",
  system: "You are a helpful assistant. Answer questions clearly and concisely.",
  model: huggingFaceModel,
});

export const processTask = inngest.createFunction(
  {
    id: "process-task",
    triggers: [{ event: "app/task.created" }], // trigger inside first object
  },
  async ({ event, step }) => {
    const aiResult = await step.run("run-ai-agent", async () => {
      const { output } = await myAgent.run(event.data.message);
      const reply = extractAssistantReply(output);
      return { reply };
    });

    const sandboxResult = await step.run("run-e2b-sandbox", async () => {
      if (!process.env.E2B_API_KEY) {
        return { ran: false as const, error: "Missing E2B_API_KEY" };
      }

      const eventCode = typeof event.data?.code === "string" ? event.data.code : null;
      const pythonFromAi = extractFencedCodeBlock(aiResult.reply, "python");
      const code = eventCode ?? pythonFromAi;

      if (!code) {
        return { ran: false as const };
      }

      try {
        const template = process.env.E2B_TEMPLATE;
        const sandbox = template ? await Sandbox.create(template) : await Sandbox.create();

        try {
          const execution = await sandbox.runCode(code);
          return {
            ran: true as const,
            codeSource: eventCode ? ("event.data.code" as const) : ("aiReply```python" as const),
            execution: execution.toJSON(),
          };
        } finally {
          await sandbox.kill().catch(() => undefined);
        }
      } catch (err) {
        return {
          ran: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    const result = await step.run("handle-task", async () => {
      return { processed: true, id: event.data.id };
    });

    await step.sleep("pause", "1s");

    return {
      message: `Task ${event.data.id} complete`,
      aiReply: aiResult.reply,
      sandbox: sandboxResult,
      result,
    };
  },
);
