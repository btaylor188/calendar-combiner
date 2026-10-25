// Runs in every page of the account sessions (Outlook and Microsoft sign-in).
// Electron has no passkey / security-key dialog on Linux, so a WebAuthn request just
// hangs until Microsoft's timeout (~10 minutes). Report that passkeys are unavailable
// and fail requests immediately, so sign-in falls back to password + your usual MFA.
const { contextBridge } = require("electron");

contextBridge.executeInMainWorld({
  func: () => {
    const unavailable = () => Promise.reject(new DOMException("Passkeys aren't available in this app.", "NotAllowedError"));
    const credentials = navigator.credentials;
    if (credentials) {
      const get = credentials.get.bind(credentials);
      const create = credentials.create.bind(credentials);
      credentials.get = (options) => (options && options.publicKey ? unavailable() : get(options));
      credentials.create = (options) => (options && options.publicKey ? unavailable() : create(options));
    }
    if (window.PublicKeyCredential) {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
      PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
    }
  },
});
