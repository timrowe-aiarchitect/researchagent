import "dotenv/config";
import { Worker } from "bullmq";

import { getRedisConnectionOptions } from "@/lib/redis";
import { SCAN_QUEUE_NAME, type ScanJobData } from "@/lib/queue";
import { runScanPipeline } from "@/lib/scan-pipeline";

const worker = new Worker<ScanJobData>(
  SCAN_QUEUE_NAME,
  async (job) => {
    await runScanPipeline(job.data.scanId);
  },
  { connection: getRedisConnectionOptions(), concurrency: 2 }
);

worker.on("completed", (job) => {
  console.log(`[scan-worker] scan ${job.data.scanId} complete`);
});

worker.on("failed", (job, err) => {
  console.error(`[scan-worker] scan ${job?.data.scanId} failed:`, err.message);
});

console.log(`[scan-worker] listening on queue "${SCAN_QUEUE_NAME}"`);
