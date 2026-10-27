import type { IssueCommentInput, IssueRef, IssueTracker } from './types.js';

export interface PlaneIssueTrackerConfig {
  baseUrl: string;
  workspaceSlug: string;
  projectId: string;
  apiKey: string;
  states: {
    aiWait: string;
    inProgress: string;
    done: string;
    humanReview: string;
  };
}

interface PlanePage<T> {
  data?: T[];
  pagination?: { style?: string };
  next?: number | null;
  has_more?: boolean;
  next_cursor?: string | null;
}

interface PlaneState {
  id: string;
  name?: string;
  group?: string;
}

interface PlaneWorkItem {
  id: string;
  identifier: string;
  name: string;
  description_html?: string;
  type?: { name?: string } | null;
  type_id?: string | null;
  priority?: string;
  state_id: string;
  state?: PlaneState | null;
  created_by_id?: string | null;
  updated_at?: string;
  project_id?: string;
}

const API_VERSION = '/api/v2';
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const ERROR_BODY_LIMIT = 1_000;

export function readPlaneIssueTrackerConfig(env: NodeJS.ProcessEnv = process.env): PlaneIssueTrackerConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when AUTO_DEV_ISSUE_TRACKER=plane`);
    return value;
  };

  const rawBaseUrl = required('AUTO_DEV_PLANE_BASE_URL');
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error('AUTO_DEV_PLANE_BASE_URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('AUTO_DEV_PLANE_BASE_URL must be HTTP(S) without credentials, query, or fragment');
  }

  return {
    baseUrl: rawBaseUrl.replace(/\/+$/, ''),
    workspaceSlug: required('AUTO_DEV_PLANE_WORKSPACE_SLUG'),
    projectId: required('AUTO_DEV_PLANE_PROJECT_ID'),
    apiKey: required('AUTO_DEV_PLANE_API_KEY'),
    states: {
      aiWait: required('AUTO_DEV_PLANE_AI_WAIT_STATE_ID'),
      inProgress: required('AUTO_DEV_PLANE_IN_PROGRESS_STATE_ID'),
      done: required('AUTO_DEV_PLANE_DONE_STATE_ID'),
      humanReview: required('AUTO_DEV_PLANE_HUMAN_REVIEW_STATE_ID'),
    },
  };
}

function htmlToText(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_match, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mapStatus(item: PlaneWorkItem, config: PlaneIssueTrackerConfig): string {
  if (item.state_id === config.states.aiWait) return 'OPEN';
  if (item.state_id === config.states.inProgress) return 'IN_PROGRESS';
  if (item.state_id === config.states.done) return 'DONE';
  if (item.state_id === config.states.humanReview) return 'HUMAN_REVIEW';
  if (item.state?.group === 'completed') return 'DONE';
  if (item.state?.group === 'cancelled') return 'DROPPED';
  if (item.state?.group === 'started') return 'IN_PROGRESS';
  return item.state?.name ?? item.state_id;
}

function mapIssue(item: PlaneWorkItem, config: PlaneIssueTrackerConfig): IssueRef {
  return {
    key: item.identifier,
    id: item.id,
    title: item.name,
    description: htmlToText(item.description_html),
    type: item.type?.name ?? '',
    priority: (item.priority ?? 'none').toUpperCase(),
    status: mapStatus(item, config),
    stateId: item.state_id,
    requesterId: item.created_by_id ?? undefined,
    updatedAt: item.updated_at ?? '',
  };
}

export function planeIssueTracker(config: PlaneIssueTrackerConfig): IssueTracker {
  const apiBase = `${config.baseUrl}${API_VERSION}`;
  const projectPath = `/workspaces/${encodeURIComponent(config.workspaceSlug)}/projects/${encodeURIComponent(config.projectId)}`;
  const headers = {
    'X-Api-Key': config.apiKey,
    Accept: 'application/json',
  };
  const validatedStateIds = new Set<string>();
  let stateValidationExpiresAt = 0;

  async function request(url: string, init?: RequestInit, operation = 'request'): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          headers: { ...headers, ...init?.headers },
          signal: init?.signal ?? AbortSignal.timeout(20_000),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        throw new Error(`Plane ${operation} request failed: ${lastError.message}`.slice(0, ERROR_BODY_LIMIT));
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1_000, 10_000)
          : 250 * (attempt + 1);
        await response.body?.cancel().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      if (response.ok) return response;

      let detail = `${response.status}`;
      try {
        const body = await response.json() as { code?: string; detail?: string; error?: string };
        detail = [body.code, body.detail ?? body.error].filter(Boolean).join(': ') || detail;
      } catch {
        // Keep the HTTP status if Plane did not return JSON.
      }
      throw new Error(`Plane ${operation} failed (${response.status}): ${detail}`.slice(0, ERROR_BODY_LIMIT));
    }
    throw lastError ?? new Error(`Plane ${operation} failed`);
  }

  async function paginated<T>(path: string, initialParams: URLSearchParams): Promise<T[]> {
    const rows: T[] = [];
    const params = new URLSearchParams(initialParams);
    params.set('per_page', String(PAGE_SIZE));
    params.set('paginate', 'cursor');
    params.set('count', 'false');
    const seenCursors = new Set<string>();

    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const url = `${apiBase}${path}?${params}`;
      const response = await request(url, undefined, `GET ${path}`);
      const page = await response.json() as PlanePage<T>;
      if (!Array.isArray(page.data)) throw new Error(`Plane GET ${path} returned an invalid page`);
      rows.push(...page.data);
      if (page.pagination?.style !== 'cursor' || page.has_more !== true) return rows;
      const cursor = page.next_cursor;
      if (!cursor || seenCursors.has(cursor)) throw new Error(`Plane GET ${path} returned a repeated or missing cursor`);
      seenCursors.add(cursor);
      params.set('cursor', cursor);
    }
    throw new Error(`Plane GET ${path} exceeded the ${MAX_PAGES}-page safety limit`);
  }

  async function validateStates(): Promise<void> {
    if (Date.now() < stateValidationExpiresAt && validatedStateIds.size > 0) return;
    const states = await paginated<PlaneState>(`${projectPath}/states/`, new URLSearchParams());
    const stateMap = new Map(states.map((state) => [state.id, state]));
    const requiredStates = Object.entries(config.states);
    if (new Set(requiredStates.map(([, id]) => id)).size !== requiredStates.length) {
      throw new Error('Plane state configuration is invalid: AI_WAIT, IN_PROGRESS, DONE, and HUMAN_REVIEW IDs must be distinct');
    }
    const missing = requiredStates.filter(([, id]) => !stateMap.has(id)).map(([role, id]) => `${role}=${id}`);
    if (missing.length) throw new Error(`Plane state configuration is invalid for project ${config.projectId}: ${missing.join(', ')}`);
    const triggerState = stateMap.get(config.states.aiWait)!;
    if (triggerState.group?.toLowerCase() === 'triage') {
      throw new Error('AUTO_DEV_PLANE_AI_WAIT_STATE_ID cannot use the Plane triage group; the default work item list excludes triage items');
    }
    validatedStateIds.clear();
    for (const [, id] of requiredStates) validatedStateIds.add(id);
    stateValidationExpiresAt = Date.now() + 60_000;
  }

  async function fetchIssue(key: string): Promise<IssueRef | null> {
    await validateStates();
    const encodedKey = encodeURIComponent(key);
    const path = `${projectPath}/work-items/${encodedKey}/?expand=state,type&fields=id,identifier,name,description_html,type_id,priority,state_id,created_by_id,updated_at,project_id`;
    let response: Response;
    try {
      response = await request(`${apiBase}${path}`, undefined, `GET work item ${key}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('(404)')) return null;
      throw err;
    }
    const item = await response.json() as PlaneWorkItem;
    if (item.project_id && item.project_id !== config.projectId) {
      throw new Error(`Plane work item ${key} belongs to a different project`);
    }
    return mapIssue(item, config);
  }

  return {
    provider: 'plane',

    async fetchOpenIssues(): Promise<IssueRef[]> {
      await validateStates();
      const params = new URLSearchParams({
        fields: 'id,identifier,name,description_html,type_id,priority,state_id,created_by_id,updated_at,project_id',
        expand: 'state,type',
      });
      const items = await paginated<PlaneWorkItem>(`${projectPath}/work-items/`, params);
      return items.filter((item) => item.state_id === config.states.aiWait).map((item) => mapIssue(item, config));
    },

    async getIssue(key: string): Promise<IssueRef | null> {
      return fetchIssue(key);
    },

    async updateIssue(key: string, patch: { status?: string; linkedRunId?: string }): Promise<void> {
      if (!patch.status) return;
      await validateStates();
      const stateId = patch.status === 'OPEN' || patch.status === 'AI_WAIT'
        ? config.states.aiWait
        : patch.status === 'IN_PROGRESS'
          ? config.states.inProgress
          : patch.status === 'DONE'
            ? config.states.done
            : patch.status === 'HUMAN_REVIEW'
              ? config.states.humanReview
              : undefined;
      if (!stateId) throw new Error(`Plane does not have a configured state mapping for ${patch.status}`);
      const keyPath = encodeURIComponent(key);
      const path = `${projectPath}/work-items/${keyPath}/`;
      await request(`${apiBase}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state_id: stateId }),
      }, `PATCH work item ${key}`);
    },

    async addComment(key: string, input: IssueCommentInput): Promise<void> {
      await validateStates();
      const item = await fetchIssue(key);
      if (!item?.id) throw new Error(`Plane work item not found for comment: ${key}`);
      const path = `${projectPath}/work-items/${encodeURIComponent(item.id)}/comments/upsert/`;
      await request(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment_html: input.html,
          access: input.access ?? 'INTERNAL',
          external_source: 'auto-dev',
          external_id: input.externalId,
        }),
      }, `UPSERT comment for ${key}`);
    },
  };
}
