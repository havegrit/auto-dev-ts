import { EventEmitter } from 'events';

export interface RunEvent {
  type: 'tool_call' | 'tool_result' | 'text' | 'status';
  ts: string;
  data: string;
}

const emitters = new Map<string, EventEmitter>();

export function getOrCreateEmitter(runId: string): EventEmitter {
  if (!emitters.has(runId)) {
    const ee = new EventEmitter();
    ee.setMaxListeners(10);
    emitters.set(runId, ee);
  }
  return emitters.get(runId)!;
}

export function emitRunEvent(runId: string, event: RunEvent): void {
  emitters.get(runId)?.emit('event', event);
}

export function closeEmitter(runId: string): void {
  const ee = emitters.get(runId);
  if (ee) {
    ee.emit('done');
    ee.removeAllListeners();
    emitters.delete(runId);
  }
}
