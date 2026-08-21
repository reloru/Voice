import type {
  CreatePhoneNumberRequest,
  CreatePhoneNumberResponse,
  PhoneNumber,
  UpdatePhoneNumberFields,
} from "./types.js";

export class XaiApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "XaiApiError";
  }

  /** 408/429/5xx are worth another attempt; 4xx means we sent something wrong. */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export interface XaiClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  /** Some endpoints (hangup) legitimately 404 once the call has already ended. */
  tolerate?: number[];
}

const RETRY_BASE_DELAY_MS = 250;

export class XaiClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: XaiClientOptions) {
    if (!options.apiKey) throw new Error("XaiClient requires an apiKey");
    this.#apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.x.ai").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  async #request<T>({ method, path, body, tolerate }: RequestOptions): Promise<T | undefined> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      try {
        const response = await this.#fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: timeout,
        });

        const text = await response.text();

        if (!response.ok) {
          if (tolerate?.includes(response.status)) return undefined;
          const parsed = safeJson(text);
          const error = new XaiApiError(
            response.status,
            typeof parsed?.code === "string" ? parsed.code : undefined,
            typeof parsed?.error === "string"
              ? parsed.error
              : `${method} ${path} failed with HTTP ${response.status}`,
            text,
          );
          if (error.retryable && attempt < this.#maxRetries) {
            lastError = error;
            await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
            continue;
          }
          throw error;
        }

        return text ? (JSON.parse(text) as T) : undefined;
      } catch (cause) {
        if (cause instanceof XaiApiError) throw cause;
        // Network error or timeout — retry, since these are usually transient.
        lastError = cause;
        if (attempt < this.#maxRetries) {
          await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw new Error(`${method} ${path} failed: ${(cause as Error).message}`, { cause });
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`${method} ${path} failed`);
  }

  // --- Call control -------------------------------------------------------

  /** Transfer a live SIP call to `tel:+E.164` or `sip:user@host`. */
  async referCall(callId: string, targetUri: string): Promise<void> {
    await this.#request({
      method: "POST",
      path: `/v1/realtime/calls/${encodeURIComponent(callId)}/refer`,
      body: { target_uri: targetUri },
    });
  }

  /** End a live SIP call. Tolerates 404 — the caller may have hung up first. */
  async hangupCall(callId: string): Promise<void> {
    await this.#request({
      method: "POST",
      path: `/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
      tolerate: [404],
    });
  }

  // --- Phone numbers ------------------------------------------------------

  async listPhoneNumbers(): Promise<PhoneNumber[]> {
    const body = await this.#request<{ phone_numbers?: PhoneNumber[] }>({
      method: "GET",
      path: "/v2/phone-numbers",
    });
    return body?.phone_numbers ?? [];
  }

  async getPhoneNumber(phoneNumberId: string): Promise<PhoneNumber | undefined> {
    const body = await this.#request<{ phone_number?: PhoneNumber } | PhoneNumber>({
      method: "GET",
      path: `/v2/phone-numbers/${encodeURIComponent(phoneNumberId)}`,
    });
    if (!body) return undefined;
    return "phone_number" in body && typeof body.phone_number === "object"
      ? body.phone_number
      : (body as PhoneNumber);
  }

  /**
   * Register a phone number. Only `origin: "byo_trunk"` works here — xAI
   * refuses to provision its own numbers over the API and directs you to the
   * console (Voice Agents) instead.
   */
  async createPhoneNumber(request: CreatePhoneNumberRequest): Promise<CreatePhoneNumberResponse> {
    const body = await this.#request<CreatePhoneNumberResponse>({
      method: "POST",
      path: "/v2/phone-numbers",
      body: request,
    });
    if (!body) throw new Error("createPhoneNumber returned an empty response");
    return body;
  }

  /**
   * Patch an existing number. The API takes a partial object plus an explicit
   * `field_mask` naming the fields to overwrite.
   */
  async updatePhoneNumber(
    phoneNumberId: string,
    fields: UpdatePhoneNumberFields,
  ): Promise<PhoneNumber | undefined> {
    const fieldMask = Object.keys(fields).join(",");
    if (!fieldMask) throw new Error("updatePhoneNumber requires at least one field to update");

    const body = await this.#request<{ phone_number?: PhoneNumber }>({
      method: "PATCH",
      path: `/v2/phone-numbers/${encodeURIComponent(phoneNumberId)}`,
      body: { phone_number: fields, field_mask: fieldMask },
    });
    return body?.phone_number;
  }

  async deletePhoneNumber(phoneNumberId: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: `/v2/phone-numbers/${encodeURIComponent(phoneNumberId)}`,
    });
  }

  /** Cheap authenticated call used by `voice-agent doctor` to validate the key. */
  async verifyApiKey(): Promise<{ redacted_api_key: string; team_id: string }> {
    const body = await this.#request<{ redacted_api_key: string; team_id: string }>({
      method: "GET",
      path: "/v1/api-key",
    });
    if (!body) throw new Error("api-key check returned an empty response");
    return body;
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
