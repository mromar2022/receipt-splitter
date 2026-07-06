import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { handleReceiptAiRequest } from "./api/openaiReceipt.js";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  process.env.OPENAI_API_KEY ||= env.OPENAI_API_KEY;
  process.env.OPENAI_MODEL ||= env.OPENAI_MODEL;

  return {
    plugins: [
      react(),
      {
        name: "receipt-ai-api",
        configureServer(server) {
          server.middlewares.use("/api/read-receipt-ai", handleReceiptAiRequest);
        },
      },
    ],
  };
});
