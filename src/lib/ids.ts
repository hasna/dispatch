import { randomBytes } from "node:crypto";

/** Generate a short, URL-safe, lowercase hex id (default 12 chars). */
export function genId(length = 12): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

/** Current time as an ISO 8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}
