import http from "http";
import { readFileSync, writeFileSync } from "fs";

const CLIENT_ID     = "25936_wyJXoIiyRGphj7yjStlSEiISf5bYM9UwPX5V7P7wV5X3r83P5F";
const CLIENT_SECRET = "Gr6d9u62ot0bjtV8ju0mLwZuQrG0KBfgp51ToP4nwbG6DCh7NA";
const REDIRECT_URI  = "http://localhost:3000/callback";

const authUrl = `https://connect.spotware.com/apps/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=trading&response_type=code`;

console.log("\n─────────────────────────────────────────────────");
console.log("  cTrader OAuth — open this URL in your browser:");
console.log("─────────────────────────────────────────────────");
console.log("\n" + authUrl + "\n");
console.log("Waiting for authorization on http://localhost:3000 ...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3000");
  const code = url.searchParams.get("code");

  if (!code) {
    res.end("No code found — please try again.");
    return;
  }

  console.log("  ✅ Auth code received:", code);
  res.end("<h2>Authorization successful! You can close this tab.</h2>");
  server.close();

  // Exchange code for tokens
  console.log("  Exchanging code for tokens...");
  const params = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri:  REDIRECT_URI,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const tokenRes = await fetch("https://connect.spotware.com/apps/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    params.toString(),
  });

  const tokens = await tokenRes.json();
  console.log("  Token response:", JSON.stringify(tokens, null, 2));

  if (tokens.access_token) {
    // Write tokens to .env
    let env = readFileSync(".env", "utf8");
    env = env.replace(/CTRADER_ACCESS_TOKEN=.*/,  `CTRADER_ACCESS_TOKEN=${tokens.access_token}`);
    env = env.replace(/CTRADER_REFRESH_TOKEN=.*/, `CTRADER_REFRESH_TOKEN=${tokens.refresh_token || ""}`);
    writeFileSync(".env", env);
    console.log("\n  ✅ Tokens saved to .env");
    console.log(`  Access token:  ${tokens.access_token.slice(0, 20)}...`);
    console.log(`  Expires in:    ${tokens.expires_in}s`);
    console.log(`  Refresh token: ${(tokens.refresh_token || "").slice(0, 20)}...`);
  } else {
    console.log("  ❌ Token exchange failed:", tokens);
  }
});

server.listen(3000);
