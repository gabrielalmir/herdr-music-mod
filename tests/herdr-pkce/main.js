import { View, div } from "gpui-kit";
import { authorize, challenge } from "./spotify.js";
// Run herdr-app check on a temporary copy with the packaged spotify.js alongside.
export default class PkceCheck extends View {
  render() {
    const attempt = authorize("a".repeat(32));
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    if (challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") !== expected ||
        !/^[A-Za-z0-9_-]{64}$/.test(attempt.verifier) ||
        !/^[A-Za-z0-9_-]{32}$/.test(attempt.state) ||
        !attempt.url.includes("code_challenge=" + challenge(attempt.verifier) + "&code_challenge_method=S256")) {
      throw Error("Invalid PKCE in the Herdr runtime.");
    }
    return div().child("PKCE S256 verified");
  }
}
