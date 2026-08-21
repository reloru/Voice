export interface WebhookSpec {
  name?: string;
  /** URL xAI POSTs signed `realtime.call.incoming` events to. */
  url: string;
  auth_url?: string;
  auth_token?: string;
}

export interface SipAuthSpec {
  auth_username?: string;
  auth_password?: string;
  /** Source CIDR ranges permitted to send INVITEs, e.g. ["203.0.113.0/24"]. */
  allowed_addresses?: string[];
}

export interface CreatePhoneNumberRequest {
  /**
   * `byo_trunk` is the only value the API accepts. `xai_provisioned` returns
   * HTTP 403 directing you to the console.
   */
  origin: "byo_trunk" | "xai_provisioned";
  name: string;
  /** E.164, required for `byo_trunk`. */
  phone_number?: string;
  area_code?: string;
  agent_id?: string;
  webhook?: WebhookSpec;
  sip_auth?: SipAuthSpec;
}

export interface PhoneNumber {
  phone_number_id: string;
  team_id?: string;
  phone_number: string;
  name: string;
  agent_id?: string;
  webhook_id?: string;
  origin: "byo_trunk" | "xai_provisioned";
  /** SIP host your carrier should route calls to, e.g. `sip.voice.x.ai`. */
  sip_host?: string;
  inbound_trunk_id?: string;
  sip_auth?: Omit<SipAuthSpec, "auth_password">;
  created_at?: string;
  updated_at?: string;
  agent_name?: string;
}

export interface CreatePhoneNumberResponse {
  phone_number: PhoneNumber;
  webhook?: {
    webhook_id: string;
    /** Returned exactly once. This is XAI_WEBHOOK_SECRET. */
    dispatch_signing_secret: string;
  };
}

export type UpdatePhoneNumberFields = Partial<
  Pick<CreatePhoneNumberRequest, "name" | "agent_id" | "webhook" | "sip_auth">
>;
