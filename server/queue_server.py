#!/usr/bin/env python3
"""
x-post-queue remote inbox server.

A tiny stdlib-only HTTP server that lets you submit posts from any device
(via a browser form or a plain curl/POST) into a local inbox file. The
browser extension polls this server (over a Cloudflare quick tunnel) and
pulls new items into its own local queue, where the normal scheduling /
safety-limit / human-like-posting logic in background.js takes over.

This process never talks to X itself — it only stores drafts. All actual
posting still happens from the extension inside your logged-in Kiwi session.

Usage:
    python3 queue_server.py [port]

On first run it generates a random auth token and prints it. Every request
(except the "/" form page) must include:
    Authorization: Bearer <token>
"""

import http.server
import json
import os
import secrets
import socketserver
import sys
import uuid
from urllib.parse import parse_qs, urlparse

DATA_DIR = os.path.expanduser("~/.local/share/x-post-queue")
INBOX_PATH = os.path.join(DATA_DIR, "inbox.json")
TOKEN_PATH = os.path.join(DATA_DIR, "token")

os.makedirs(DATA_DIR, exist_ok=True)


def load_token():
    if os.path.exists(TOKEN_PATH):
        with open(TOKEN_PATH) as f:
            return f.read().strip()
    token = secrets.token_urlsafe(24)
    with open(TOKEN_PATH, "w") as f:
        f.write(token)
    os.chmod(TOKEN_PATH, 0o600)
    return token


def load_inbox():
    if not os.path.exists(INBOX_PATH):
        return []
    try:
        with open(INBOX_PATH) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def save_inbox(items):
    tmp = INBOX_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(items, f)
    os.replace(tmp, INBOX_PATH)


TOKEN = load_token()

FORM_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Queue an X post</title>
<style>
  body {{ font-family: system-ui, sans-serif; max-width: 480px; margin: 24px auto; padding: 0 12px; }}
  textarea {{ width: 100%; box-sizing: border-box; min-height: 90px; font-size: 15px; padding: 8px; }}
  input[type=file], input[type=datetime-local] {{ width: 100%; margin-top: 8px; box-sizing: border-box; }}
  button {{ margin-top: 10px; width: 100%; padding: 10px; font-size: 15px; background: #1d9bf0; color: #fff; border: none; border-radius: 6px; }}
  #status {{ margin-top: 10px; font-size: 14px; }}
</style>
</head>
<body>
<h2>Queue a post</h2>
<textarea id="text" placeholder="What's happening?"></textarea>
<input type="file" id="media" accept="image/*,video/*">
<input type="datetime-local" id="when">
<button id="submit">Add to queue</button>
<div id="status"></div>
<script>
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";

function fileToBase64(file) {{
  return new Promise((resolve, reject) => {{
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  }});
}}

document.getElementById("submit").onclick = async () => {{
  const text = document.getElementById("text").value.trim();
  const file = document.getElementById("media").files[0];
  const when = document.getElementById("when").value;
  const statusEl = document.getElementById("status");
  if (!text && !file) {{ statusEl.textContent = "Enter text or attach media."; return; }}

  let media = null;
  if (file) {{
    statusEl.textContent = "Encoding file...";
    media = {{ name: file.name, type: file.type, base64: await fileToBase64(file) }};
  }}

  const scheduledAt = when ? new Date(when).getTime() : null;
  statusEl.textContent = "Sending...";
  try {{
    const res = await fetch("/add", {{
      method: "POST",
      headers: {{ "Content-Type": "application/json", "Authorization": "Bearer " + token }},
      body: JSON.stringify({{ text, media, scheduledAt }}),
    }});
    const data = await res.json();
    if (data.ok) {{
      statusEl.textContent = "Queued. It'll post next time the extension checks in.";
      document.getElementById("text").value = "";
      document.getElementById("media").value = "";
      document.getElementById("when").value = "";
    }} else {{
      statusEl.textContent = "Error: " + (data.error || "unknown");
    }}
  }} catch (e) {{
    statusEl.textContent = "Error: " + e.message;
  }}
}};
</script>
</body>
</html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        return auth == "Bearer " + TOKEN

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            body = FORM_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/pending":
            if not self._authorized():
                return self._send_json(401, {"error": "unauthorized"})
            return self._send_json(200, {"ok": True, "items": load_inbox()})

        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""

        if parsed.path == "/add":
            if not self._authorized():
                return self._send_json(401, {"error": "unauthorized"})
            try:
                data = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return self._send_json(400, {"error": "invalid json"})

            text = (data.get("text") or "").strip()
            media = data.get("media")
            if not text and not media:
                return self._send_json(400, {"error": "text or media required"})

            item = {
                "id": str(uuid.uuid4()),
                "text": text,
                "media": media,
                "scheduledAt": data.get("scheduledAt"),
                "createdAt": None,
            }
            import time

            item["createdAt"] = int(time.time() * 1000)

            inbox = load_inbox()
            inbox.append(item)
            save_inbox(inbox)
            return self._send_json(200, {"ok": True, "id": item["id"]})

        if parsed.path == "/ack":
            if not self._authorized():
                return self._send_json(401, {"error": "unauthorized"})
            try:
                data = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return self._send_json(400, {"error": "invalid json"})
            ids = set(data.get("ids") or [])
            inbox = load_inbox()
            remaining = [i for i in inbox if i["id"] not in ids]
            save_inbox(remaining)
            return self._send_json(200, {"ok": True, "removed": len(inbox) - len(remaining)})

        self._send_json(404, {"error": "not found"})


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"x-post-queue server listening on http://127.0.0.1:{port}")
    print(f"token: {TOKEN}")
    print(f"local form: http://127.0.0.1:{port}/?token={TOKEN}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
