// The form a person pastes a secret into: one page on 127.0.0.1, at an
// address with a one-time nonce in it, in their own browser.
//
// A value that fails its check is refused on the same page, which says
// why and asks again; nothing is handed back until one passes, the person
// cancels, or the time runs out. The page never shows a value, and every
// answer tells the browser not to keep it.
//
// The field is a text field masked by CSS (`-webkit-text-security`), never
// type=password: a browser treats a submitted password field as a sign-in and
// offers to save it, and browsers ignore autocomplete=off for that
// (MDN, Turning off form autocompletion). The CSS is non-standard; MDN allows
// such a feature where no standard option exists (MDN, -webkit-text-security).
//
// Only this machine reaches it, and only through the address it printed,
// once. It listens on 127.0.0.1, and the address it hands out is the one the
// socket says it listens on. The nonce in that address opens the form once:
// the first GET trades it for the form's cookie (HttpOnly, SameSite=Strict,
// named for the form's port) and sends the browser to the form's own address,
// "/", with no nonce in it. Every later request needs that cookie or is not
// found, so a copy of the address that leaked (the printed line, the
// browser's command line or history) is dead once the person's browser has
// opened it; the same browser, cookie and all, is only sent back to the form.
// Both the nonce and the cookie are compared in constant time.
//
// A request whose Host is not the form's address is refused (another name
// that resolves here, as a DNS rebinding page's would). A POST a browser
// marks as sent from another page is refused before anything else is looked
// at: an Origin other than the form's own, "null" included (a sandboxed
// frame, a data: or file: page, or a page that sends no referrer; the form's
// own same-origin referrer policy has the browser send its real origin), or a
// Sec-Fetch-Site other than same-origin, or none, the person's own
// navigation. A client that sends neither header, a script on this machine,
// is judged by the Host and the cookie.
//
// What the person pastes is trimmed at both ends, and a key with a space or
// line break inside it is refused. A profile can also give the key's shape:
// a pattern and the words that say it ("start with napi_ and have no
// spaces"). A value without that shape is refused before its check is asked.
// The same words are said in the page as the person pastes, by the page's one
// script, built from the two functions below and allowed by its hash alone. It
// takes the paste itself, because a text field drops a line break silently,
// joining two lines into one; it never shows a character of the value, and,
// the policy having no connect-src, can send nothing anywhere.
//
// A profile can name the page where the key is made. The form links to it
// under the prompt, in a new tab, with rel="noopener noreferrer": the page it
// opens learns neither the form's address, nonce and all, nor a way back to
// its window. A link is no script, so the policy stays as it is.

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { platform } from "node:os";

const MAX_BODY = 64 * 1024;

/**
 * A paste split into the key and what came around it: the key without the
 * whitespace at either end, the words for what was there ("a line break at
 * the end"), empty when nothing was, and whether whitespace is inside the key.
 * Pure: it runs in the page as well.
 */
export function trimNotes(raw) {
  const lead = /^\s*/.exec(raw)[0];
  const rest = raw.slice(lead.length);
  const trail = rest.length - rest.trimEnd().length;
  const value = rest.slice(0, rest.length - trail);
  const words = (ws) => {
    const breaks = (ws.match(/\r\n|\n|\r/g) || []).length;
    const spaces = ws.replace(/\r\n|\n|\r/g, "").length;
    const parts = [];
    if (breaks)
      parts.push(breaks === 1 ? "a line break" : `${breaks} line breaks`);
    if (spaces) parts.push(spaces === 1 ? "a space" : `${spaces} spaces`);
    return parts.join(" and ");
  };
  const at = [];
  if (lead) at.push(`${words(lead)} at the start`);
  if (trail) at.push(`${words(rest.slice(rest.length - trail))} at the end`);
  return { value, found: at.join(", and "), inside: /\s/.test(value) };
}

/**
 * Whether a trimmed key has its shape: { ok } and, when not, the words that
 * say why, which never quote it. shape is { pattern, says } or null;
 * spacesInside lets whitespace through for a secret that has it.
 */
export function shapeVerdict(value, shape, spacesInside) {
  if (!spacesInside && /\s/.test(value))
    return {
      ok: false,
      words: "It has a space or line break inside it; a key has none.",
    };
  if (shape && !new RegExp(shape.pattern, "u").test(value))
    return {
      ok: false,
      words: `It doesn't look right: it should ${shape.says}.`,
    };
  return { ok: true, words: "" };
}

/**
 * The page's one script: what the person hears as they paste or type. Its
 * line breaks are made \n: a function's source keeps a checkout's \r\n, which
 * a browser's parser drops, and the hash it then takes would not be the
 * policy's.
 */
const SCRIPT = `(() => {
${trimNotes}
${shapeVerdict}
const field = document.querySelector("input[name=v]");
const status = document.getElementById("status");
const shape = field.dataset.pattern ? { pattern: field.dataset.pattern, says: field.dataset.says } : null;
const spacesInside = field.dataset.spaces === "1";
const say = (state, text) => { status.dataset.state = state; status.textContent = text; };
const tell = (raw, pasted) => {
  const t = trimNotes(raw);
  if (!t.value) return say("", t.found ? "Only spaces or line breaks; nothing to send." : "");
  const v = shapeVerdict(t.value, shape, spacesInside);
  const around = t.found ? (pasted ? "Trimmed " + t.found + "." : "The " + t.found + " will be trimmed.") : "";
  const verdict = v.ok ? (around ? "Otherwise it looks right." : "It looks right.") : v.words;
  say(v.ok ? "fits" : "wrong", [around, verdict].filter(Boolean).join(" "));
};
field.addEventListener("paste", (e) => {
  const raw = e.clipboardData ? e.clipboardData.getData("text") : null;
  if (raw === null) return;
  e.preventDefault();
  const t = trimNotes(raw);
  if (t.inside && !spacesInside) {
    field.value = "";
    return say("wrong", "That paste has a space or line break inside the key, so it wasn't put in. Copy the key alone and paste it again.");
  }
  field.value = t.value;
  tell(raw, true);
});
field.addEventListener("input", () => tell(field.value, false));
})();`.replace(/\r\n?/g, "\n");

const HEADERS = {
  "Cache-Control": "no-store",
  // The form's own POST then carries its real Origin, so "null" can be refused; its address holds no
  // nonce by then, and its one link (rel=noreferrer) sends none anyway.
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
};

const STYLE = `:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,sans-serif;max-width:500px;margin:50px auto;padding:20px;background:Canvas;color:CanvasText}
h1{font-size:18px;margin:0 0 8px}
p{font-size:14px;margin:0 0 16px;line-height:1.5}
.error{color:light-dark(#a1001b,#ff8d94);font-weight:600}
input{display:block;width:100%;padding:12px;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid GrayText;border-radius:6px;box-sizing:border-box;background:Field;color:FieldText}
input[name=v]{-webkit-text-security:disc}
.row{display:flex;gap:8px;margin-top:12px}
button{padding:10px 20px;font-size:14px;background:CanvasText;color:Canvas;border:1px solid CanvasText;border-radius:6px;cursor:pointer}
button.secondary{background:transparent;color:CanvasText}
.note{margin-top:24px;opacity:.7;font-size:12px}
.status{font-size:13px;min-height:1.4em;margin:8px 0 0}
.status[data-state=wrong]{color:light-dark(#a1001b,#ff8d94)}
.status[data-state=fits]{color:light-dark(#0a6b2d,#7ee2a1)}`;

/** The text, safe inside HTML. */
export function htmlEscape(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

const page = (title, inner) =>
  `<!doctype html><html lang=en><head><meta charset=utf-8><title>${htmlEscape(title)}</title>
<meta name=viewport content="width=device-width,initial-scale=1"><style>${STYLE}</style></head>
<body>${inner}</body></html>`;

/**
 * Opens the URL in the default browser. SECRET_PASTE_NO_BROWSER=1 leaves
 * it to the caller (a test, or a session with no desktop). Says whether it
 * tried.
 */
export function openBrowser(url) {
  if (process.env.SECRET_PASTE_NO_BROWSER) return false;
  const p = platform();
  const [cmd, args] =
    p === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : p === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const fail = (err) =>
    console.error(
      `Couldn't auto-launch browser (${err.message}). Open the URL manually.`,
    );
  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.on("error", fail);
    child.unref();
  } catch (err) {
    fail(err);
  }
  return true;
}

const sameNonce = (given, nonce) => {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(nonce);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** A listening socket's address as a URL's host and port: 127.0.0.1:<port>, [::1]:<port>. */
export const hostOf = ({ address, family, port }) =>
  family === "IPv6" ? `[${address}]:${port}` : `${address}:${port}`;

/**
 * Whether a browser marks the request as sent from another page than the
 * form at `here` (its host and port): an Origin other than the form's own,
 * "null" included, or a Sec-Fetch-Site other than same-origin or none.
 */
export function fromAnotherPage(headers, here) {
  const origin = headers.origin;
  if (origin !== undefined && origin !== `http://${here}`) return true;
  const site = headers["sec-fetch-site"];
  return site !== undefined && site !== "same-origin" && site !== "none";
}

/** The values a Cookie header gives the cookie `name`, each as sent. */
export function cookiesNamed(header, name) {
  if (typeof header !== "string") return [];
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${name}=`))
    .map((pair) => pair.slice(name.length + 1));
}

/**
 * Serves the form until a value passes its check. Resolves with
 *   { status: "ok", value, reached }
 *   { status: "cancelled" } | { status: "timeout" } | { status: "empty" }
 *   { status: "bind-error", message }
 *
 * check(value) resolves { ok, reason, reached } and never shows the value;
 * without one, any value passes. emptyEnds makes an empty submission end
 * it ("empty") rather than ask again. successText(reached) is the last
 * page's words. With trim (the default), the value is trimmed, and one
 * without its shape ({ pattern, says }, or none) or with whitespace inside
 * (unless spacesInside) is refused before check is asked. url, an https
 * address its caller has checked (profiles.mjs), is the page where the key
 * is made, linked under the prompt.
 */
export function captureSecret({
  title,
  prompt,
  url = null,
  note,
  timeoutSec = 300,
  check = null,
  shape = null,
  spacesInside = false,
  trim = true,
  emptyEnds = false,
  onListening = () => {},
  onRejected = () => {},
  successText = (reached) =>
    `Received.${reached ? ` The key reached ${reached}.` : ""} Running the command — you can close this tab.`,
}) {
  return new Promise((resolve) => {
    const nonce = randomBytes(24).toString("base64url");
    /** The form's cookie's value, what the nonce is traded for: never in an address. */
    const pass = randomBytes(24).toString("base64url");
    const server = createServer();
    /** The host and port it listens on, set once it listens: the only Host it answers. */
    let here = null;
    /** The form's cookie's name, set once it listens: one per port, as a browser keeps cookies by host alone. */
    let cookie = null;
    /** Whether the printed address has been opened: its nonce is then spent. */
    let traded = false;
    let finished = false;
    let checking = false;
    let lastError = null;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      server.closeIdleConnections();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ status: "timeout" }),
      timeoutSec * 1000,
    );

    const send = (res, status, html, last = false) => {
      res.writeHead(status, {
        ...HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        ...(last ? { Connection: "close" } : {}),
      });
      res.end(html);
    };
    const backToForm = (res, set = {}) => {
      res.writeHead(303, { ...HEADERS, ...set, Location: "/" });
      res.end();
    };
    const withPass = (req) =>
      cookiesNamed(req.headers.cookie, cookie).some((v) => sameNonce(v, pass));
    const formPage = () =>
      page(
        title,
        `<h1>${htmlEscape(title)}</h1>
<p>${htmlEscape(prompt)}</p>
${url ? `<p><a href="${htmlEscape(url)}" target=_blank rel="noopener noreferrer">Make one at ${htmlEscape(new URL(url).host)}</a> (opens in a new tab)</p>` : ""}
${lastError ? `<p class=error role=alert>${htmlEscape(lastError)}</p>` : ""}
<form method=post action="/">
<input name=v type=text aria-label="${htmlEscape(title)}" autocomplete=off autocapitalize=off autocorrect=off spellcheck=false autofocus required${trim ? ` aria-describedby=status${shape ? ` data-pattern="${htmlEscape(shape.pattern)}" data-says="${htmlEscape(shape.says)}"` : ""}${spacesInside ? " data-spaces=1" : ""}` : ""}>
${trim ? `<p id=status class=status role=status aria-live=polite></p>` : ""}
<div class=row><button type=submit>Submit</button><button type=submit class=secondary formaction="/cancel" formnovalidate>Cancel</button></div>
</form>
${note ? `<p class=note>${htmlEscape(note)}</p>` : ""}
${trim ? `<script>${SCRIPT}</script>` : ""}`,
      );
    const endPage = (text) =>
      page(title, `<h1>${htmlEscape(title)}</h1><p>${htmlEscape(text)}</p>`);

    server.on("error", (err) =>
      finish({ status: "bind-error", message: err.message }),
    );

    server.on("request", (req, res) => {
      if (here === null || req.headers.host !== here) {
        res.writeHead(403, HEADERS).end();
        return;
      }
      if (req.method === "POST" && fromAnotherPage(req.headers, here)) {
        res.writeHead(403, HEADERS).end();
        return;
      }
      const url = new URL(req.url, `http://${here}`);
      if (finished) {
        res.writeHead(404, HEADERS).end();
        return;
      }
      // The printed address. Its first GET trades the nonce for the cookie; after that, only the
      // browser holding the cookie is sent on to the form, and anything else is not found.
      if (url.searchParams.has("n")) {
        if (req.method !== "GET" || url.pathname !== "/") {
          res.writeHead(404, HEADERS).end();
          return;
        }
        if (traded) {
          if (withPass(req)) return backToForm(res);
          return send(
            res,
            404,
            endPage(
              "This address opens the form once, and it has been opened: the form is in the tab that opened it first.",
            ),
          );
        }
        if (!sameNonce(url.searchParams.get("n"), nonce)) {
          res.writeHead(404, HEADERS).end();
          return;
        }
        traded = true;
        return backToForm(res, {
          "Set-Cookie": `${cookie}=${pass}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(timeoutSec)}`,
        });
      }
      if (!withPass(req)) {
        res.writeHead(404, HEADERS).end();
        return;
      }
      if (url.pathname === "/" && req.method === "GET")
        return send(res, 200, formPage());
      if (url.pathname === "/cancel" && req.method === "POST") {
        send(res, 200, endPage("Cancelled. Nothing was run."), true);
        return finish({ status: "cancelled" });
      }
      if (url.pathname !== "/" || req.method !== "POST") {
        res.writeHead(405, HEADERS).end();
        return;
      }

      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          res.writeHead(413, HEADERS).end();
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", async () => {
        if (finished || size > MAX_BODY) return;
        const raw =
          new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get(
            "v",
          ) ?? "";
        const pasted = trim
          ? trimNotes(raw)
          : { value: raw, found: "", inside: false };
        const value = pasted.value;
        if (!value) {
          if (emptyEnds) {
            send(res, 200, endPage("Empty value. Nothing was run."), true);
            return finish({ status: "empty" });
          }
          lastError = "Nothing was pasted.";
          return backToForm(res);
        }
        if (trim) {
          const shaped = shapeVerdict(value, shape, spacesInside);
          if (!shaped.ok) {
            lastError = `${shaped.words} Nothing was checked.`;
            onRejected(shaped.words);
            return backToForm(res);
          }
        }
        if (checking) {
          lastError =
            "The last key is still being checked; try again in a moment.";
          return backToForm(res);
        }
        checking = true;
        let result;
        try {
          result = check ? await check(value) : { ok: true, reached: null };
        } catch {
          // What a failed check threw may quote the value; say only that it failed.
          result = { ok: false, reason: "the check itself failed" };
        }
        checking = false;
        if (finished)
          return send(
            res,
            410,
            endPage("This form has closed. Nothing was run."),
            true,
          );
        if (!result.ok) {
          lastError = `That key didn't work: ${result.reason}`;
          onRejected(result.reason);
          return backToForm(res);
        }
        send(
          res,
          200,
          endPage(
            `${pasted.found ? `Trimmed ${pasted.found}. ` : ""}${successText(result.reached)}`,
          ),
          true,
        );
        finish({ status: "ok", value, reached: result.reached ?? null });
      });
    });

    server.listen(0, "127.0.0.1", () => {
      here = hostOf(server.address());
      cookie = `secret-run-${server.address().port}`;
      onListening(`http://${here}/?n=${nonce}`);
    });
  });
}
