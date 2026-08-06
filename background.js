// Service worker: periodically checks the local queue and auto-posts anything due.
// NOTE: on Android/Kiwi this only runs while the browser is open/foregrounded —
// there is no true background execution while the app is fully closed.

importScripts("idb.js");

const ALARM_NAME = "check-queue";
const TARGET_URL = "https://x.com/home";
let isProcessing = false;

// Now that posting is confirmed working, run quietly in the background instead
// of stealing focus. Flip back to true if you need to watch a run again.
const DEBUG_VISIBLE_TAB = false;

const DEFAULT_SETTINGS = {
  intervalMinutes: 60,
  intervalJitterPercent: 35,
  maxPostsPerDay: 15,
  remoteUrl: "",
  remoteToken: "",
  autoModeEnabled: false,
  autoModeQuery: "",
  autoModeApiKey: "",
  autoModeCaption: "",
  autoModeCredit: true,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    Promise.all([pollRemoteInbox(), maybeTopUpAutoMode()]).finally(() => runQueueCheck());
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CHECK_NOW") {
    Promise.all([pollRemoteInbox(), maybeTopUpAutoMode()]).finally(() =>
      runQueueCheck().then(() => sendResponse({ ok: true }))
    );
    return true; // keep channel open for async response
  }
  if (msg?.type === "RESUME_AUTOMATION") {
    chrome.storage.local
      .set({ automationPaused: false, pauseReason: null, consecutiveFailures: 0 })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Plain fetch() has no built-in timeout — a stalled mobile connection would
// otherwise hang a poll cycle indefinitely instead of surfacing an error.
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getQueue() {
  const { queue } = await chrome.storage.local.get("queue");
  return Array.isArray(queue) ? queue : [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

async function getPostLog() {
  const { postLog } = await chrome.storage.local.get("postLog");
  return Array.isArray(postLog) ? postLog : [];
}

async function recordPosted() {
  const log = await getPostLog();
  log.push(Date.now());
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await chrome.storage.local.set({ postLog: log.filter((ts) => ts > cutoff).slice(-500) });
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

async function getProcessedRemoteIds() {
  const { processedRemoteIds } = await chrome.storage.local.get("processedRemoteIds");
  return Array.isArray(processedRemoteIds) ? processedRemoteIds : [];
}

// Pulls new items from the remote inbox server (if configured) into the local
// queue, so posts can be submitted from any device without touching Kiwi.
// The remote server never talks to X directly — it only hands off drafts here.
async function pollRemoteInbox() {
  const settings = await getSettings();
  if (!settings.remoteUrl || !settings.remoteToken) return;

  try {
    const res = await fetchWithTimeout(settings.remoteUrl + "/pending", {
      headers: { Authorization: "Bearer " + settings.remoteToken },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];

    if (items.length === 0) {
      await chrome.storage.local.set({ lastRemotePoll: { at: Date.now(), pulled: 0, error: null } });
      return;
    }

    const processed = new Set(await getProcessedRemoteIds());
    const queue = await getQueue();
    const ackIds = [];
    let addedCount = 0;

    for (const remote of items) {
      ackIds.push(remote.id);
      if (processed.has(remote.id)) continue; // already imported in a prior poll; just clean it up server-side

      let media = null;
      if (remote.media && remote.media.base64) {
        const mediaId = crypto.randomUUID();
        const blob = base64ToBlob(remote.media.base64, remote.media.type);
        await saveMedia(mediaId, blob, remote.media.name || "upload", remote.media.type || "");
        media = { id: mediaId, name: remote.media.name || "upload", type: remote.media.type || "" };
      }

      queue.push({
        id: crypto.randomUUID(),
        text: (remote.text || "").trim(),
        media,
        scheduledAt: remote.scheduledAt || null,
        dueJitterMs: remote.scheduledAt ? Math.floor(Math.random() * 3 * 60 * 1000) : 0,
        status: "pending",
        error: null,
        postedAt: null,
        createdAt: Date.now(),
        source: "remote",
      });
      processed.add(remote.id);
      addedCount++;
    }

    await setQueue(queue);
    await chrome.storage.local.set({ processedRemoteIds: Array.from(processed).slice(-1000) });

    // Best-effort cleanup; a failed ack just means these get skipped (dedup'd) next poll.
    fetchWithTimeout(settings.remoteUrl + "/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.remoteToken },
      body: JSON.stringify({ ids: ackIds }),
    }, 10000).catch(() => {});

    await chrome.storage.local.set({
      lastRemotePoll: { at: Date.now(), pulled: addedCount, error: null },
    });
  } catch (e) {
    await chrome.storage.local.set({ lastRemotePoll: { at: Date.now(), pulled: 0, error: e.message } });
  }
}

// If auto mode is on, keeps exactly one stock photo queued up at a time
// (never stockpiles ahead) so there's always something ready when the
// existing min-gap/daily-cap gate in runQueueCheck next allows a post.
// Images come from Pexels' API, which licenses photos for reuse — this does
// NOT scrape or repost arbitrary images found via a search engine.
async function maybeTopUpAutoMode() {
  const settings = await getSettings();
  if (!settings.autoModeEnabled || !settings.autoModeApiKey) return;

  const queue = await getQueue();
  const alreadyQueued = queue.some((i) => i.status === "pending" && i.source === "auto-image");
  if (alreadyQueued) return;

  try {
    const query = (settings.autoModeQuery || "").trim();
    const url = query
      ? `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&page=${
          1 + Math.floor(Math.random() * 100)
        }`
      : `https://api.pexels.com/v1/curated?per_page=1&page=${1 + Math.floor(Math.random() * 500)}`;

    const res = await fetchWithTimeout(url, { headers: { Authorization: settings.autoModeApiKey } });
    if (!res.ok) throw new Error("Pexels API HTTP " + res.status);
    const data = await res.json();
    const photo = (data.photos || [])[0];
    if (!photo) throw new Error(query ? `No results for "${query}"` : "No curated photo returned");

    const imgRes = await fetchWithTimeout(photo.src.large || photo.src.original, {}, 30000);
    if (!imgRes.ok) throw new Error("Image download HTTP " + imgRes.status);
    const blob = await imgRes.blob();

    const mediaId = crypto.randomUUID();
    const filename = `pexels-${photo.id}.jpg`;
    await saveMedia(mediaId, blob, filename, blob.type || "image/jpeg");

    let caption = (settings.autoModeCaption || "").trim();
    if (settings.autoModeCredit !== false) {
      const credit = `📷 ${photo.photographer} / Pexels`;
      caption = caption ? `${caption}\n\n${credit}` : credit;
    }

    const fresh = await getQueue();
    fresh.push({
      id: crypto.randomUUID(),
      text: caption,
      media: { id: mediaId, name: filename, type: blob.type || "image/jpeg" },
      scheduledAt: null,
      dueJitterMs: 0,
      status: "pending",
      error: null,
      postedAt: null,
      createdAt: Date.now(),
      source: "auto-image",
    });
    await setQueue(fresh);
    await chrome.storage.local.set({ lastAutoModeFetch: { at: Date.now(), query, error: null } });
  } catch (e) {
    await chrome.storage.local.set({ lastAutoModeFetch: { at: Date.now(), error: e.message } });
  }
}

function jitter(min, max) {
  return min + Math.random() * (max - min);
}

// A fixed gap (even a generous one) is itself a machine-like fingerprint —
// identical spacing between every post. Instead we pick a fresh randomized
// delay after each post, centered on the target interval, so the cadence is
// "roughly every N minutes" without ever being exactly N minutes twice in a row.
function computeNextEligibleDelay(settings) {
  const baseMs = settings.intervalMinutes * 60 * 1000;
  const jitterFrac = Math.max(0, Math.min(0.9, (settings.intervalJitterPercent || 0) / 100));
  return jitter(baseMs * (1 - jitterFrac), baseMs * (1 + jitterFrac));
}

// Gate on safety limits + pause state. Does NOT gate on whether anything is
// actually due — callers check that separately.
async function checkCanPost() {
  const { automationPaused, pauseReason, nextEligibleAt, lastPostedAt } = await chrome.storage.local.get([
    "automationPaused",
    "pauseReason",
    "nextEligibleAt",
    "lastPostedAt",
  ]);
  if (automationPaused) return { ok: false, reason: pauseReason || "Automation is paused" };

  const now = Date.now();
  const settings = await getSettings();

  // nextEligibleAt is set right after every successful post and survives
  // restarts (chrome.storage.local, not session). If it's ever missing —
  // e.g. a partial storage wipe — but we still have a record of when we
  // last actually posted, rebuild the gate from that instead of treating
  // "no record found" as "safe to post immediately."
  let gateUntil = nextEligibleAt;
  if (!gateUntil && lastPostedAt) {
    gateUntil = lastPostedAt + computeNextEligibleDelay(settings);
    await chrome.storage.local.set({ nextEligibleAt: gateUntil });
  }

  if (gateUntil && now < gateUntil) {
    const waitMin = Math.ceil((gateUntil - now) / 60000);
    return {
      ok: false,
      reason: `Throttled: next post eligible ~${new Date(gateUntil).toLocaleTimeString()} (${waitMin}m)`,
    };
  }

  const log = await getPostLog();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const last24h = log.filter((ts) => ts > dayAgo).length;
  if (last24h >= settings.maxPostsPerDay) {
    return { ok: false, reason: `Throttled: daily cap of ${settings.maxPostsPerDay} posts reached` };
  }

  return { ok: true };
}

async function pauseAutomation(reason) {
  await chrome.storage.local.set({ automationPaused: true, pauseReason: reason });
}

async function runQueueCheck() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const queue = await getQueue();
    const now = Date.now();
    const due = queue.find(
      (item) =>
        item.status === "pending" &&
        (item.scheduledAt === null || item.scheduledAt + (item.dueJitterMs || 0) <= now)
    );
    if (!due) return;

    const gate = await checkCanPost();
    if (!gate.ok) return; // leave item pending, just not its turn yet

    const result = await postOne(due.text, due.media || null);

    const fresh = await getQueue();
    const idx = fresh.findIndex((i) => i.id === due.id);
    const { consecutiveFailures } = await chrome.storage.local.get("consecutiveFailures");

    if (result.success) {
      await recordPosted();
      const settings = await getSettings();
      const postedAt = Date.now();
      await chrome.storage.local.set({
        consecutiveFailures: 0,
        lastPostedAt: postedAt,
        nextEligibleAt: postedAt + computeNextEligibleDelay(settings),
      });
      if (idx !== -1) {
        fresh[idx].status = "posted";
        fresh[idx].postedAt = Date.now();
        fresh[idx].error = null;
        if (due.media) await deleteMedia(due.media.id).catch(() => {});
      }
    } else {
      const isChallenge = /^CHALLENGE_DETECTED/.test(result.error || "");
      const failures = (consecutiveFailures || 0) + 1;
      await chrome.storage.local.set({ consecutiveFailures: failures });

      if (idx !== -1) {
        const attempts = (fresh[idx].attempts || 0) + 1;
        fresh[idx].attempts = attempts;
        fresh[idx].error = result.error || "Unknown error";
        // Transient failures (network blip, X being slow) get a few automatic
        // retries at the normal cadence instead of dying and needing a manual
        // "Post now". Challenge/captcha failures never auto-retry — see below.
        const MAX_ATTEMPTS = 3;
        fresh[idx].status = !isChallenge && attempts < MAX_ATTEMPTS ? "pending" : "failed";
      }

      if (isChallenge) {
        await pauseAutomation(
          "X showed a verification/challenge screen — stopped to avoid making it worse. Resolve manually in the app, then resume."
        );
      } else if (failures >= 3) {
        await pauseAutomation(
          `${failures} posts failed in a row — pausing so we don't hammer X. Check what's happening, then resume.`
        );
      }
    }
    if (idx !== -1) await setQueue(fresh);
  } finally {
    isProcessing = false;
  }
}

function waitForTabComplete(tabId, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for tab to load"));
    }, timeout);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// One tab, reused across every post, instead of opening a fresh tab and
// destroying it each time. Falls back to creating a new one if the previous
// tab was closed (by you, or by Kiwi reclaiming memory) or navigated away.
async function getOrCreateManagedTab() {
  const { managedTabId } = await chrome.storage.session.get("managedTabId");
  if (managedTabId) {
    try {
      const existing = await chrome.tabs.get(managedTabId);
      if (existing) {
        await chrome.tabs.update(existing.id, { url: TARGET_URL });
        await waitForTabComplete(existing.id);
        return { tabId: existing.id, fresh: false };
      }
    } catch (e) {
      // Tab's gone — fall through and make a new one.
    }
  }
  // No managed tab yet — either the very first run, or Kiwi just (re)started
  // and storage.session was cleared. Either way this is a cold load, which
  // needs more settle time than a tab that's already warmed up and hydrated.
  const tab = await chrome.tabs.create({ url: TARGET_URL, active: DEBUG_VISIBLE_TAB });
  await waitForTabComplete(tab.id);
  await chrome.storage.session.set({ managedTabId: tab.id });
  return { tabId: tab.id, fresh: true };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function postOne(text, media) {
  try {
    let mediaBase64 = null;
    let mediaType = null;
    let mediaName = null;
    if (media) {
      const record = await getMedia(media.id);
      if (!record) throw new Error("Attached media not found (was it deleted?)");
      const buffer = await record.blob.arrayBuffer();
      mediaBase64 = arrayBufferToBase64(buffer);
      mediaType = record.type;
      mediaName = record.name;
    }

    const { tabId, fresh } = await getOrCreateManagedTab();
    // Give the SPA a moment to hydrate after "complete" fires — jittered so
    // every run doesn't take an identical, machine-like amount of time.
    // A freshly-created tab (first run, or Kiwi just restarted) needs
    // noticeably longer — "network complete" fires well before the compose
    // toolbar has actually finished mounting on a cold load.
    const settleRange = fresh ? [3500, 7000] : [1200, 2800];
    await new Promise((r) => setTimeout(r, jitter(settleRange[0], settleRange[1])));

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: xAutoPostInjected,
      args: [text, mediaBase64, mediaType, mediaName],
    });

    return (
      results?.[0]?.result || {
        success: false,
        error: "No result from injected script",
      }
    );
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Injected into the x.com page. Must be fully self-contained (no outer-scope refs).
function xAutoPostInjected(text, mediaBase64, mediaType, mediaName) {
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function jitter(min, max) {
    return min + Math.random() * (max - min);
  }
  function waitFor(selectors, timeout, interval) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function tick() {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) return resolve(el);
        }
        if (Date.now() - start > timeout) {
          return reject(new Error("Timed out waiting for: " + selectors.join(", ")));
        }
        setTimeout(tick, interval);
      })();
    });
  }

  function base64ToFile(base64, mimeType, name) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name, { type: mimeType });
  }

  function detectChallenge() {
    const arkose = document.querySelector(
      'iframe[src*="arkoselabs"], #arkose-iframe, [id*="arkose"]'
    );
    if (arkose) return "Arkose/FunCaptcha challenge iframe present";
    const bodyText = (document.body.innerText || "").slice(0, 4000);
    if (/unusual activity|verify you.?re human|confirm your identity|account.*locked|suspended/i.test(bodyText)) {
      return "Page text suggests a verification/lock screen";
    }
    return null;
  }

  async function humanType(editor, text) {
    editor.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    let i = 0;
    while (i < text.length) {
      const chunkLen = 1 + Math.floor(Math.random() * 3); // 1-3 chars at a time
      const chunk = text.slice(i, i + chunkLen);
      const inserted = document.execCommand("insertText", false, chunk);
      if (!inserted) {
        editor.textContent = text;
        editor.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
        );
        return;
      }
      i += chunkLen;
      const baseDelay = jitter(30, 100);
      const thinkPause = Math.random() < 0.08 ? jitter(200, 700) : 0; // occasional pause, like a real typist
      await sleep(baseDelay + thinkPause);
    }
  }

  return (async () => {
    try {
      const challengeAtStart = detectChallenge();
      if (challengeAtStart) throw new Error("CHALLENGE_DETECTED: " + challengeAtStart);

      const editorSelectors = [
        '[data-testid="tweetTextarea_0"]',
        'div[aria-label="Post text"]',
        'div[role="textbox"][contenteditable="true"]',
      ];
      const editor = await waitFor(editorSelectors, 20000, 250);

      // Brief human-like pause before starting to type, as if reading the screen.
      await sleep(jitter(400, 1300));

      if (text) {
        await humanType(editor, text);
        await sleep(jitter(500, 1400));
      }

      if (mediaBase64) {
        await sleep(jitter(300, 900));
        const fileInputSelectors = [
          'input[data-testid="fileInput"]',
          'input[type="file"][accept*="video"]',
          'input[type="file"][accept*="image"]',
          'input[type="file"]',
        ];
        // Same 20s patience as the editor — on a cold Kiwi start the compose
        // toolbar (which the file input lives in) can mount well after the
        // textarea does, and 10s wasn't always enough for it to show up.
        const fileInput = await waitFor(fileInputSelectors, 20000, 250);
        const file = base64ToFile(mediaBase64, mediaType, mediaName || "upload");
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      }

      const buttonSelectors = ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]'];
      const button = await waitFor(buttonSelectors, 10000, 250);

      // Media upload can take a while (esp. video) and X keeps the post
      // button disabled until it finishes, so give it much longer than text-only.
      const buttonTimeout = mediaBase64 ? (mediaType?.startsWith("video") ? 90000 : 30000) : 10000;
      const start = Date.now();
      while (button.getAttribute("aria-disabled") === "true") {
        if (Date.now() - start > buttonTimeout) {
          const mid = detectChallenge();
          if (mid) throw new Error("CHALLENGE_DETECTED: " + mid);
          throw new Error(
            mediaBase64
              ? "Post button stayed disabled — media may still be uploading/processing or was rejected"
              : "Post button stayed disabled (empty text or blocked?)"
          );
        }
        await sleep(200);
      }

      // Human-like pause before submitting, as if reviewing the post.
      await sleep(jitter(800, 2600));
      if (button.getAttribute("aria-disabled") === "true") {
        throw new Error("Post button re-disabled right before click — media likely still processing");
      }

      // Plain .click() alone sometimes doesn't register with X's handlers reliably;
      // fire a full pointer/mouse sequence to match a real tap.
      const evtOpts = { bubbles: true, cancelable: true, view: window };
      button.dispatchEvent(new PointerEvent("pointerdown", evtOpts));
      button.dispatchEvent(new MouseEvent("mousedown", evtOpts));
      button.dispatchEvent(new PointerEvent("pointerup", evtOpts));
      button.dispatchEvent(new MouseEvent("mouseup", evtOpts));
      button.click();

      // Verify the post actually went through: either an error toast appears,
      // or the composer clears/resets (X's normal post-success behavior).
      const verifyDeadline = Date.now() + 8000;
      let toastError = null;
      let cleared = false;
      while (Date.now() < verifyDeadline) {
        const challenge = detectChallenge();
        if (challenge) throw new Error("CHALLENGE_DETECTED: " + challenge);

        const toast = document.querySelector('[data-testid="toast"]');
        if (toast && /wrong|failed|error|try again|limit/i.test(toast.textContent || "")) {
          toastError = toast.textContent.trim();
          break;
        }
        const stillEditor = document.querySelector(editorSelectors.join(","));
        if (!stillEditor || (stillEditor.textContent || "").trim() === "") {
          cleared = true;
          break;
        }
        await sleep(250);
      }

      if (toastError) throw new Error("X reported an error: " + toastError);
      if (!cleared) {
        throw new Error(
          "Clicked Post but the composer never cleared — post likely did not submit (button click may not have registered)"
        );
      }

      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  })();
}
