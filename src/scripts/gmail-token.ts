// Connects the Gmail account that sends Mizan's emails: `npm run gmail:token`.
//
// Asks for the OAuth client (Google Cloud → Google Auth Platform → Clients, type
// "Desktop app"), opens Google's consent page in the browser, and on approval prints
// the four GMAIL_* values to set on the server. It then sends a test email to the
// account itself, so you know the values work before you deploy them.
// Run it on your own machine: the printed values are secrets, keep them out of chats and git.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline/promises";
import { createGmailSender, GMAIL_SEND_SCOPE, GmailError, GOOGLE_TOKEN_URL } from "../lib/gmail.js";

const WAIT_MS = 10 * 60 * 1000;

function openInBrowser(url: string) {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command as string, args as string[], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // The URL is printed as well.
  }
}

async function ask(question: string, fallback?: string) {
  if (fallback) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  if (!answer) throw new Error("Nothing entered.");
  return answer;
}

/** Waits for Google to send the browser back with a code; returns the code and the address it came to. */
async function consent(clientId: string) {
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  let redirectUri = "";
  const code = await new Promise<string>((resolve, reject) => {
    const page = (title: string) =>
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${title}</h2><p>You can close this tab.</p>`;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/" || (!url.searchParams.has("code") && !url.searchParams.has("error"))) {
        res.writeHead(404).end();
        return;
      }
      const finish = (ok: boolean, message: string) => {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(page(message));
        clearTimeout(timer);
        server.close();
      };
      if (url.searchParams.get("state") !== state) {
        finish(false, "This link doesn't belong to this run.");
        reject(new Error("The answer from Google didn't match this run (state). Run the command again."));
      } else if (url.searchParams.has("error")) {
        finish(false, "Not allowed.");
        reject(new Error(`Google said: ${url.searchParams.get("error")}. Run again and press Allow.`));
      } else {
        // The code is exchanged after this page is shown: the terminal has the result.
        finish(true, "Got it. The result is in the terminal.");
        resolve(url.searchParams.get("code")!);
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("No answer from the browser within 10 minutes."));
    }, WAIT_MS);
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: `openid email ${GMAIL_SEND_SCOPE}`,
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      console.log("\nOpening Google in your browser. Sign in with the Gmail account that will send Mizan's emails.");
      console.log("If it says the app isn't verified: Advanced → Go to Mizan (it's your own app).");
      console.log("Tick the permission to send email, then Continue.\n");
      console.log(`If the browser didn't open, paste this link into it:\n${auth.toString()}\n`);
      // --no-browser: only print the link (e.g. on a machine without a browser).
      if (!process.argv.includes("--no-browser")) openInBrowser(auth.toString());
    });
  });
  return { code, redirectUri, verifier };
}

async function main() {
  console.log("Connect the Gmail account that sends Mizan's emails.\n");
  const clientId = await ask("OAuth Client ID: ", process.env.GMAIL_CLIENT_ID?.trim());
  const clientSecret = await ask("OAuth Client secret: ", process.env.GMAIL_CLIENT_SECRET?.trim());

  const { code, redirectUri, verifier } = await consent(clientId);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const tokens = (await res.json()) as { refresh_token?: string; id_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok) throw new Error(`Google refused the code: ${tokens.error} ${tokens.error_description ?? ""}`);
  if (!tokens.scope?.split(" ").includes(GMAIL_SEND_SCOPE)) {
    throw new Error("The permission to send email wasn't ticked on Google's page. Run again and tick it.");
  }
  if (!tokens.refresh_token) throw new Error("Google sent no refresh token. Run again (it asks for consent each time).");
  const payload = JSON.parse(Buffer.from(tokens.id_token?.split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as { email?: string };
  if (!payload.email) throw new Error("Google didn't say which account this is. Run again.");
  const sender = payload.email;

  console.log(`Connected ${sender}. Sending a test email to it...`);
  await createGmailSender({ clientId, clientSecret, refreshToken: tokens.refresh_token, sender })({
    fromName: "Mizan",
    to: sender,
    subject: "ميزان: تم ربط Gmail بنجاح",
    text: "لو وصلتك الرسالة دي، يبقى ميزان يقدر يبعت إيميلات من الحساب ده.\n\nIf you got this, Mizan can send email from this account.",
    html: '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px"><p>لو وصلتك الرسالة دي، يبقى <b>ميزان</b> يقدر يبعت إيميلات من الحساب ده.</p><p dir="ltr" style="color:#6b7b73">If you got this, Mizan can send email from this account.</p></div>',
  });
  console.log("Test email sent: check that inbox.\n");
  console.log("Set these four variables on the server (Railway → mizan_back → Variables), then deploy:\n");
  console.log(`GMAIL_SENDER=${sender}`);
  console.log(`GMAIL_CLIENT_ID=${clientId}`);
  console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`);
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("\nKeep them secret. Leave RESEND_API_KEY empty there, or Resend is used instead.");
}

main().catch((err: unknown) => {
  // Google's own words say what to fix (e.g. "Gmail API has not been used in project ...": enable it).
  const detail = err instanceof GmailError && err.detail.body ? `\n${err.detail.status}: ${err.detail.body}` : "";
  console.error(`\n${err instanceof Error ? err.message : String(err)}${detail}`);
  // Not process.exit(): on Windows that can crash Node while a connection is still closing.
  process.exitCode = 1;
});
