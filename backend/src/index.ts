import { createApp } from "./app";
import { prewarmLLMJudge } from "./lib/llmJudge";

const app = createApp();
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`jeopardy backend listening on :${port}`);
  // Fire-and-forget: load llama3.2 into Ollama memory so the first real
  // judge call doesn't pay a ~15s cold-start.
  void prewarmLLMJudge().then(() => console.log("llm judge prewarmed"));
});
