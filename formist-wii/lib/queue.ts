import { Queue } from "bullmq";

import { getRedisConnectionOptions } from "@/lib/redis";

export const SCAN_QUEUE_NAME = "wii-scan-jobs";

export type ScanJobData = {
  scanId: string;
};

const globalForQueue = globalThis as unknown as {
  scanQueue: Queue<ScanJobData> | undefined;
};

export const scanQueue =
  globalForQueue.scanQueue ??
  new Queue<ScanJobData>(SCAN_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.scanQueue = scanQueue;
}
