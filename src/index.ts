import { loadAgentConfig } from "./config/agent.js";
import { loadEnv } from "./config/env.js";
import { buildServer } from "./server.js";
import { FileCallStore } from "./storage/file.js";
import { XaiClient } from "./xai/client.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const config = await loadAgentConfig(env.AGENT_CONFIG_PATH);

  const { app, manager } = await buildServer({
    env,
    config,
    xai: new XaiClient({ apiKey: env.XAI_API_KEY, baseUrl: env.XAI_API_BASE }),
    store: new FileCallStore(env.DATA_DIR),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      // Hang up live calls before the process dies, so nobody is left on a
      // silent line waiting for an agent that is no longer there.
      await manager.shutdown();
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "shutdown failed");
      process.exit(1);
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await app.listen({ host: env.HOST, port: env.PORT });

  app.log.info(
    {
      agent: config.agent.name,
      owner: config.owner.name,
      voice: config.agent.voice,
      model: config.agent.model,
      transferEnabled: config.transfer.enabled,
      webhookPath: "/webhooks/xai",
    },
    "voice agent ready",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
