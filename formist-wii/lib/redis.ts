// BullMQ bundles its own ioredis internally, so Queue/Worker take plain connection
// options here rather than an externally-constructed ioredis client (mixing two
// separate ioredis installations breaks TypeScript's structural checks).
export function getRedisConnectionOptions() {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set");
  }
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null as null,
  };
}
