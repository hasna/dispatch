import type { DispatchBackend } from "../types.js";

export function normalizeBackend(input?: string, env: NodeJS.ProcessEnv = process.env): DispatchBackend {
  const raw = (input ?? env.DISPATCH_BACKEND ?? "tmux").trim().toLowerCase();
  if (raw === "tmux" || raw === "") return "tmux";
  if (raw === "mosaic") return "mosaic";
  throw new Error(`unsupported dispatch backend: ${input ?? env.DISPATCH_BACKEND}. Use tmux or mosaic.`);
}

