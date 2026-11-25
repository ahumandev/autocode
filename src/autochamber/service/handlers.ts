import { loadAutocodeConfigDetails } from "../../config.js";
import type { CredentialProviderPolicy } from "../../credentials/types.js";
import {
  createCredentialProfileService,
  type CredentialServiceErrorCode,
  type CredentialServiceResult,
} from "../credentials.js";
import { readSettings, SettingsError, updateSettings, type SettingsErrorCode } from "../settings.js";
import {
  AutoChamberContextInputError,
  resolveAutoChamberSettingsContext,
  type AutoChamberServiceBootstrap,
} from "./context.js";
import { AutoChamberServiceResponse, type AutoChamberServiceHandlers } from "./server.js";

export type { AutoChamberServiceHandlers } from "./server.js";

const SETTINGS_MESSAGES: Readonly<Record<SettingsErrorCode, string>> = {
  invalid_request: "Invalid settings request.",
  invalid_config: "Invalid settings configuration.",
  conflict: "Settings revision is stale.",
  io_error: "Settings storage is unavailable.",
};

const CREDENTIAL_MESSAGES: Readonly<Record<CredentialServiceErrorCode, string>> = {
  invalid_request: "Invalid credential request.",
  confirmation_required: "Credential update confirmation is required.",
  plaintext_confirmation_required: "Plaintext credentials are stored unencrypted; confirmation is required.",
  provider_not_allowed: "Credential provider is not allowed.",
  provider_unavailable: "Credential provider is unavailable.",
  duplicate_profile: "Credential profile already exists.",
  profile_not_found: "Credential profile was not found.",
  profile_shadowed: "Credential profile is shadowed.",
  stale_revision: "Credential profile revision is stale.",
  profile_drift: "Credential profile cannot be safely updated.",
  write_failed: "Credential write failed.",
};

function settingsFailure(error: unknown): AutoChamberServiceResponse {
  const code = error instanceof AutoChamberContextInputError ? "invalid_request"
    : error instanceof SettingsError ? error.code : undefined;
  if (code === undefined || !Object.hasOwn(SETTINGS_MESSAGES, code)) throw error;
  const status = code === "invalid_request" ? 400 : code === "io_error" ? 500 : 409;
  return new AutoChamberServiceResponse(status, { error: { code, message: SETTINGS_MESSAGES[code] } });
}

function credentialFailure(code: CredentialServiceErrorCode): AutoChamberServiceResponse {
  if (!Object.hasOwn(CREDENTIAL_MESSAGES, code)) throw new Error("Unknown credential failure");
  const status = code === "profile_not_found" ? 404
    : code === "write_failed" ? 500
    : ["duplicate_profile", "profile_shadowed", "stale_revision", "profile_drift"].includes(code) ? 409 : 400;
  return new AutoChamberServiceResponse(status, { ok: false, error: { code, message: CREDENTIAL_MESSAGES[code] } });
}

function credentialResult<T>(result: CredentialServiceResult<T>): Record<string, unknown> | AutoChamberServiceResponse {
  if (!result.ok) return credentialFailure(result.error.code);
  return { ok: true, data: result.data };
}

function allowedKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(body).every((key): boolean => keys.includes(key));
}

export function createAutoChamberServiceHandlers(bootstrap: AutoChamberServiceBootstrap): AutoChamberServiceHandlers {
  const profiles = createCredentialProfileService({
    async loadPolicy(): Promise<CredentialProviderPolicy> {
      const details = await loadAutocodeConfigDetails({});
      if (details.failure !== undefined || details.config === undefined
        || details.candidates.some((candidate): boolean => candidate.roles.includes("global") && candidate.state === "unreadable")) {
        throw new Error("Credential policy unavailable");
      }
      return details.config.credentials.provider;
    },
  });
  return {
    async getSettings(directory?: string): Promise<Record<string, unknown> | AutoChamberServiceResponse> {
      try {
        const resolved = await resolveAutoChamberSettingsContext(directory, bootstrap);
        const snapshot = await readSettings(resolved.context);
        return { ...snapshot, ...(resolved.notice === undefined ? {} : { notice: resolved.notice }) };
      } catch (error: unknown) {
        return settingsFailure(error);
      }
    },
    async patchSettings(body: Record<string, unknown>): Promise<Record<string, unknown> | AutoChamberServiceResponse> {
      try {
        if (!allowedKeys(body, ["directory", "scopeId", "revision", "patches"])
          || (Object.hasOwn(body, "directory") && (typeof body.directory !== "string" || body.directory.length === 0))
          || typeof body.scopeId !== "string" || typeof body.revision !== "string" || !Array.isArray(body.patches)) {
          throw new AutoChamberContextInputError();
        }
        const directory = typeof body.directory === "string" ? body.directory : undefined;
        const resolved = await resolveAutoChamberSettingsContext(directory, bootstrap);
        const snapshot = await updateSettings(resolved.context, {
          scopeId: body.scopeId, revision: body.revision, patches: body.patches,
        });
        return { ...snapshot, ...(resolved.notice === undefined ? {} : { notice: resolved.notice }) };
      } catch (error: unknown) {
        return settingsFailure(error);
      }
    },
    async listProfiles(): Promise<Record<string, unknown> | AutoChamberServiceResponse> {
      return credentialResult(await profiles.listCredentialProfiles());
    },
    async createProfile(body: Record<string, unknown>): Promise<Record<string, unknown> | AutoChamberServiceResponse> {
      if (!allowedKeys(body, ["kind", "id", "provider", "fields", "confirmPlaintext"])) return credentialFailure("invalid_request");
      return credentialResult(await profiles.createCredentialProfile(body));
    },
    async patchProfile(body: Record<string, unknown>): Promise<Record<string, unknown> | AutoChamberServiceResponse> {
      if (!allowedKeys(body, ["kind", "id", "provider", "revision", "confirm", "fields", "confirmPlaintext"])) {
        return credentialFailure("invalid_request");
      }
      return credentialResult(await profiles.updateCredentialProfile(body));
    },
  };
}
