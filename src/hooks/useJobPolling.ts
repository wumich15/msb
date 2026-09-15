"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { limits } from "@/lib/config";

export interface JobStatus {
  id: string;
  type: string;
  state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  stage: string | null;
  errorCode: string | null;
  isTerminal: boolean;
}

/**
 * Polls an authorized job every two seconds while the tab is visible, backing off
 * and stopping at a terminal state. Reloading the page reconnects to the persisted
 * job rather than losing track of it.
 */
export function useJobPolling(jobId: string | null, onTerminal?: (job: JobStatus) => void) {
  const [job, setJob] = useState<JobStatus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<number>(limits.jobPollIntervalMs);
  const terminalHandler = useRef(onTerminal);

  useEffect(() => {
    terminalHandler.current = onTerminal;
  }, [onTerminal]);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }

    let cancelled = false;
    intervalRef.current = limits.jobPollIntervalMs;

    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        timer.current = setTimeout(poll, limits.jobPollMaxIntervalMs);
        return;
      }

      try {
        const result = await api<{ job: JobStatus }>(`/api/jobs/${jobId}`);
        if (cancelled) return;
        setJob(result.job);
        if (result.job.isTerminal) {
          terminalHandler.current?.(result.job);
          return;
        }
      } catch {
        // Back off on failure rather than hammering an unavailable endpoint.
        intervalRef.current = Math.min(intervalRef.current * 2, limits.jobPollMaxIntervalMs);
      }
      timer.current = setTimeout(poll, intervalRef.current);
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId]);

  return job;
}
