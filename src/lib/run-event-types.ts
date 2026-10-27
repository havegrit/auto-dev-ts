export interface RunEvent {
  type: 'tool_call' | 'tool_result' | 'text' | 'usage' | 'status' | 'warn';
  ts: string;
  data: string;
}
