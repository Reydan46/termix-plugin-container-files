import { describe, expect, it } from "vitest";
import {
  hostKeyDeclinedKey,
  hostKeyInfoOf,
} from "../../src/frontend/hostKeyPrompt";

describe("hostKeyInfoOf", () => {
  it("reads a new key question", () => {
    expect(
      hostKeyInfoOf({
        requires_host_key: true,
        scenario: "new",
        ip: "10.0.0.7",
        port: 2222,
        hostname: "host-7",
        fingerprint: "aabbcc",
        keyType: "ssh-ed25519",
        algorithm: "sha256",
      }),
    ).toEqual({
      scenario: "new",
      ip: "10.0.0.7",
      port: 2222,
      hostname: "host-7",
      fingerprint: "aabbcc",
      oldFingerprint: undefined,
      keyType: "ssh-ed25519",
      oldKeyType: undefined,
      algorithm: "sha256",
    });
  });

  it("keeps the old fingerprint of a changed key", () => {
    expect(
      hostKeyInfoOf({
        requires_host_key: true,
        scenario: "changed",
        fingerprint: "aabbcc",
        oldFingerprint: "112233",
        oldKeyType: "ssh-rsa",
      }),
    ).toMatchObject({
      scenario: "changed",
      oldFingerprint: "112233",
      oldKeyType: "ssh-rsa",
      port: 22,
    });
  });

  it("is null for any other step, or one without a fingerprint", () => {
    expect(hostKeyInfoOf({ success: true })).toBeNull();
    expect(hostKeyInfoOf({ requires_totp: true })).toBeNull();
    expect(hostKeyInfoOf({ requires_host_key: true })).toBeNull();
  });
});

describe("hostKeyDeclinedKey", () => {
  it("names a message for the two decisions only", () => {
    expect(hostKeyDeclinedKey("HOST_KEY_REJECTED")).toBe(
      "containerFiles.hostKeyRejected",
    );
    expect(hostKeyDeclinedKey("HOST_KEY_TIMEOUT")).toBe(
      "containerFiles.hostKeyTimeout",
    );
    expect(hostKeyDeclinedKey("SOMETHING_ELSE")).toBeNull();
    expect(hostKeyDeclinedKey(undefined)).toBeNull();
  });
});
