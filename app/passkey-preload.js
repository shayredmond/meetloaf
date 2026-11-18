// Passkeys fail fast. Registered on the default session (main.js), so it runs
// in every MeetLoaf window, including Google sign-in popups that a per-window
// preload doesn't reach.
//
// Electron has no WebAuthn prompt of its own, so on macOS and Linux a
// navigator.credentials request for a passkey or security key shows nothing
// and never settles: Google's sign-in page just sits on a spinner. The only
// way to the macOS passkey sheet is Apple's browser-only entitlement (see
// electron-webauthn), which an ad-hoc-signed app can't carry. Until then, say
// up front that there's no authenticator and reject passkey requests at once,
// so Google moves on to its other sign-in options. As a preload this runs
// before any page script, which a did-finish-load injection would be too late
// for.
const { contextBridge } = require('electron');

try {
  contextBridge.executeInMainWorld({
    func: () => {
      const PKC = window.PublicKeyCredential;
      const creds = navigator.credentials;
      if (!PKC || !creds) return;
      const reject = () => Promise.reject(new DOMException(
        "Passkeys aren't supported in MeetLoaf. Choose another way to sign in.",
        'NotAllowedError'));
      const origGet = creds.get.bind(creds);
      const origCreate = creds.create.bind(creds);
      // Password and federated credential requests still go through.
      creds.get = (opts) => (opts && opts.publicKey ? reject() : origGet(opts));
      creds.create = (opts) => (opts && opts.publicKey ? reject() : origCreate(opts));
      PKC.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
      PKC.isConditionalMediationAvailable = () => Promise.resolve(false);
      if (PKC.getClientCapabilities) {
        const origCaps = PKC.getClientCapabilities.bind(PKC);
        PKC.getClientCapabilities = () => origCaps().then((caps) => ({
          ...caps,
          conditionalCreate: false,
          conditionalGet: false,
          hybridTransport: false,
          passkeyPlatformAuthenticator: false,
          userVerifyingPlatformAuthenticator: false,
        }));
      }
    },
  });
} catch (_) {
  // A page without a main world to run in (or an Electron without
  // executeInMainWorld): leave WebAuthn as it is.
}
