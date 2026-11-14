import { getFreeModels } from "../lib/llm/openrouter";

async function main() {
  const models = await getFreeModels();
  console.log(`${models.length} free chat model(s), ${models.filter(({ id }) => /deepseek/i.test(id)).length} matching DeepSeek.`);
  for (const model of models) {
    const flag = /deepseek/i.test(model.id) ? " [DeepSeek]" : "";
    console.log(`${model.id}${flag} | context ${model.context_length ?? "unknown"} | ${model.supported_parameters.join(", ")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Model discovery failed.");
  process.exitCode = 1;
});
