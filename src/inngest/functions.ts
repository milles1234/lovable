// src/inngest/functions.ts
import { inngest } from "./client";
import { createAgent, openai, type Message, type TextContent, type TextMessage } from "@inngest/agent-kit";

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

    const result = await step.run("handle-task", async () => {
      return { processed: true, id: event.data.id };
    });

    await step.sleep("pause", "1s");

    return {
      message: `Task ${event.data.id} complete`,
      aiReply: aiResult.reply,
      result,
    };
  },
);
