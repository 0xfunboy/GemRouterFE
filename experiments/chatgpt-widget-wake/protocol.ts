import { z } from 'zod';

export const BUILD = 'widget-wake-0.1.3';
export const PREFIX = '/widget-wake-probe';
// Explicitly extended by the operator for the 24-hour lifetime experiment.
// Enrollment never renews this fixed deadline; individual events stay short-lived.
export const SESSION_MS = 24 * 60 * 60_000;
export const EVENT_MS = 60_000;
export const CODE_MS = SESSION_MS;
export const STOPPED_RETENTION_MS = 30 * 60_000;
export const MAX_REMOTE = 6;
export const marker = z.string().regex(/^probe_[a-f0-9]{24}$/);
export const eventSchema = z.object({
  eventId: marker, kind: z.literal('status-probe'),
  emittedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
export type ProbeEvent = z.infer<typeof eventSchema>;
export const receiptSchema = z.object({
  eventId: marker,
  stage: z.enum(['received', 'bridge_requested', 'bridge_resolved', 'bridge_rejected', 'bridge_ambiguous', 'discarded']),
  method: z.enum(['ui/message', 'openai.sendFollowUpMessage']),
  elapsedMs: z.number().min(0).max(120_000),
  result: z.enum(['none', 'accepted', 'isError', 'exception', 'timeout', 'expired', 'duplicate', 'busy']),
  rpcCode: z.number().int().optional(),
  visibility: z.enum(['visible', 'hidden']),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;
export const observationSchema = z.object({
  eventId: marker,
  outcome: z.enum(['model-tool', 'message-only', 'no-turn', 'approval', 'tool-missing', 'worker-mismatch']),
  workerId: z.string().max(80).optional(),
  targetConfirmed: z.literal(true), turnEnded: z.literal(true),
  conditions: z.enum(['foreground', 'background', 'offscreen']),
}).strict();
