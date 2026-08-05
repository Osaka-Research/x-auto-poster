const textEl = document.getElementById("text");
const whenEl = document.getElementById("when");
const addBtn = document.getElementById("addBtn");
const checkNowBtn = document.getElementById("checkNowBtn");
const listEl = document.getElementById("list");
const mediaEl = document.getElementById("media");
const mediaInfoEl = document.getElementById("mediaInfo");
const pauseBanner = document.getElementById("pauseBanner");
const pauseReasonText = document.getElementById("pauseReasonText");
const resumeBtn = document.getElementById("resumeBtn");
const intervalMinutesEl = document.getElementById("intervalMinutes");
const intervalJitterEl = document.getElementById("intervalJitter");
const intervalPreviewEl = document.getElementById("intervalPreview");
const maxDailyEl = document.getElementById("maxDaily");
const remoteUrlEl = document.getElementById("remoteUrl");
const remoteTokenEl = document.getElementById("remoteToken");
const remoteStatusEl = document.getElementById("remoteStatus");
const autoModeEnabledEl = document.getElementById("autoModeEnabled");
const autoModeQueryEl = document.getElementById("autoModeQuery");
const autoModeApiKeyEl = document.getElementById("autoModeApiKey");
const autoModeCaptionEl = document.getElementById("autoModeCaption");
const autoModeCreditEl = document.getElementById("autoModeCredit");
const autoModeStatusEl = document.getElementById("autoModeStatus");

const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100MB sanity cap
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
const MAX_SCHEDULE_JITTER_MS = 3 * 60 * 1000; // up to 3 min, so posts don't fire on the exact minute

mediaEl.onchange = () => {
  const file = mediaEl.files[0];
  if (!file) {
    mediaInfoEl.textContent = "";
    return;
  }
  if (file.size > MAX_MEDIA_BYTES) {
    mediaInfoEl.textContent = `Too large (${(file.size / 1024 / 1024).toFixed(1)}MB) — pick a smaller file`;
    mediaEl.value = "";
    return;
  }
  mediaInfoEl.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
};

async function getQueue() {
  const { queue } = await chrome.storage.local.get("queue");
  return Array.isArray(queue) ? queue : [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
}

function fmt(ts) {
  if (!ts) return "ASAP (next check)";
  return new Date(ts).toLocaleString();
}

async function renderPauseBanner() {
  const { automationPaused, pauseReason } = await chrome.storage.local.get([
    "automationPaused",
    "pauseReason",
  ]);
  if (automationPaused) {
    pauseBanner.style.display = "block";
    pauseReasonText.textContent = pauseReason || "Automation is paused.";
  } else {
    pauseBanner.style.display = "none";
  }
}

resumeBtn.onclick = () => {
  chrome.runtime.sendMessage({ type: "RESUME_AUTOMATION" }, () => renderPauseBanner());
};

function renderIntervalPreview() {
  const interval = Math.max(1, parseInt(intervalMinutesEl.value, 10) || 1);
  const jitterPct = Math.max(0, Math.min(90, parseInt(intervalJitterEl.value, 10) || 0));
  const jitterFrac = jitterPct / 100;
  const lo = Math.round(interval * (1 - jitterFrac));
  const hi = Math.round(interval * (1 + jitterFrac));
  intervalPreviewEl.textContent = `≈ every ${lo}-${hi} min, randomized each time`;
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  intervalMinutesEl.value = merged.intervalMinutes;
  intervalJitterEl.value = merged.intervalJitterPercent;
  maxDailyEl.value = merged.maxPostsPerDay;
  remoteUrlEl.value = merged.remoteUrl;
  remoteTokenEl.value = merged.remoteToken;
  autoModeEnabledEl.checked = !!merged.autoModeEnabled;
  autoModeQueryEl.value = merged.autoModeQuery;
  autoModeApiKeyEl.value = merged.autoModeApiKey;
  autoModeCaptionEl.value = merged.autoModeCaption;
  autoModeCreditEl.checked = merged.autoModeCredit !== false;
  renderIntervalPreview();
}

async function saveSettings() {
  const intervalMinutes = Math.max(1, parseInt(intervalMinutesEl.value, 10) || 1);
  const intervalJitterPercent = Math.max(0, Math.min(90, parseInt(intervalJitterEl.value, 10) || 0));
  const maxPostsPerDay = Math.max(1, parseInt(maxDailyEl.value, 10) || 1);
  const remoteUrl = remoteUrlEl.value.trim().replace(/\/+$/, "");
  const remoteToken = remoteTokenEl.value.trim();
  const autoModeEnabled = autoModeEnabledEl.checked;
  const autoModeQuery = autoModeQueryEl.value.trim();
  const autoModeApiKey = autoModeApiKeyEl.value.trim();
  const autoModeCaption = autoModeCaptionEl.value.trim();
  const autoModeCredit = autoModeCreditEl.checked;
  await chrome.storage.local.set({
    settings: {
      intervalMinutes,
      intervalJitterPercent,
      maxPostsPerDay,
      remoteUrl,
      remoteToken,
      autoModeEnabled,
      autoModeQuery,
      autoModeApiKey,
      autoModeCaption,
      autoModeCredit,
    },
  });
  renderIntervalPreview();
}

intervalMinutesEl.onchange = saveSettings;
intervalJitterEl.onchange = saveSettings;
maxDailyEl.onchange = saveSettings;
remoteUrlEl.onchange = saveSettings;
remoteTokenEl.onchange = saveSettings;
autoModeEnabledEl.onchange = saveSettings;
autoModeQueryEl.onchange = saveSettings;
autoModeApiKeyEl.onchange = saveSettings;
autoModeCaptionEl.onchange = saveSettings;
autoModeCreditEl.onchange = saveSettings;

async function renderAutoModeStatus() {
  const { lastAutoModeFetch } = await chrome.storage.local.get("lastAutoModeFetch");
  if (!lastAutoModeFetch) {
    autoModeStatusEl.textContent = "";
    return;
  }
  const when = new Date(lastAutoModeFetch.at).toLocaleTimeString();
  autoModeStatusEl.textContent = lastAutoModeFetch.error
    ? `Last fetch ${when}: error — ${lastAutoModeFetch.error}`
    : `Last fetch ${when}: queued a photo${lastAutoModeFetch.query ? ` for "${lastAutoModeFetch.query}"` : ""}`;
}

async function renderRemoteStatus() {
  const { lastRemotePoll } = await chrome.storage.local.get("lastRemotePoll");
  if (!lastRemotePoll) {
    remoteStatusEl.textContent = "";
    return;
  }
  const when = new Date(lastRemotePoll.at).toLocaleTimeString();
  remoteStatusEl.textContent = lastRemotePoll.error
    ? `Last poll ${when}: error — ${lastRemotePoll.error}`
    : `Last poll ${when}: pulled ${lastRemotePoll.pulled}`;
}

async function render() {
  const queue = await getQueue();
  listEl.innerHTML = "";
  if (queue.length === 0) {
    listEl.innerHTML = '<div class="empty">No queued posts yet</div>';
    return;
  }
  const sorted = [...queue].sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
  for (const item of sorted) {
    const li = document.createElement("li");

    const text = document.createElement("div");
    text.className = "text";
    if (item.media) {
      const chip = document.createElement("span");
      chip.className = "media-chip";
      chip.textContent = item.media.type?.startsWith("video") ? "🎬" : "🖼️";
      chip.title = item.media.name;
      text.appendChild(chip);
    }
    text.appendChild(document.createTextNode(item.text));

    const meta = document.createElement("div");
    meta.className = "meta";
    const sourceTag =
      item.source === "auto-image" ? " · auto" : item.source === "remote" ? " · remote" : "";
    const attemptsTag =
      item.attempts > 0 ? ` · attempt ${item.attempts}${item.status === "pending" ? " (retrying)" : ""}` : "";
    meta.innerHTML =
      `<span class="status ${item.status}">${item.status}</span> · ${fmt(item.scheduledAt)}${sourceTag}${attemptsTag}` +
      (item.error ? ` · ${item.error}` : "");

    const actions = document.createElement("div");
    actions.className = "actions";

    if (item.status !== "posted") {
      const postNowBtn = document.createElement("button");
      postNowBtn.textContent = "Post now";
      postNowBtn.onclick = async () => {
        const q = await getQueue();
        const idx = q.findIndex((i) => i.id === item.id);
        if (idx !== -1) {
          q[idx].scheduledAt = null;
          q[idx].status = "pending";
          q[idx].error = null;
          await setQueue(q);
          await render();
          chrome.runtime.sendMessage({ type: "CHECK_NOW" }, () => render());
        }
      };
      actions.appendChild(postNowBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.onclick = async () => {
      const q = await getQueue();
      await setQueue(q.filter((i) => i.id !== item.id));
      if (item.media) await deleteMedia(item.media.id).catch(() => {});
      render();
    };
    actions.appendChild(delBtn);

    li.appendChild(text);
    li.appendChild(meta);
    li.appendChild(actions);
    listEl.appendChild(li);
  }
}

addBtn.onclick = async () => {
  const text = textEl.value.trim();
  const file = mediaEl.files[0] || null;
  if (!text && !file) return;
  const scheduledAt = whenEl.value ? new Date(whenEl.value).getTime() : null;

  let media = null;
  if (file) {
    const mediaId = crypto.randomUUID();
    await saveMedia(mediaId, file, file.name, file.type);
    media = { id: mediaId, name: file.name, type: file.type };
  }

  const queue = await getQueue();
  queue.push({
    id: crypto.randomUUID(),
    text,
    media,
    scheduledAt,
    // Small random delay added on top of scheduledAt so posts don't fire at
    // an exact, machine-like timestamp. Not applied to ASAP/"Post now" items.
    dueJitterMs: scheduledAt ? Math.floor(Math.random() * MAX_SCHEDULE_JITTER_MS) : 0,
    status: "pending",
    error: null,
    postedAt: null,
    createdAt: Date.now(),
  });
  await setQueue(queue);

  textEl.value = "";
  whenEl.value = "";
  mediaEl.value = "";
  mediaInfoEl.textContent = "";
  render();
};

checkNowBtn.onclick = () => {
  chrome.runtime.sendMessage({ type: "CHECK_NOW" }, () => render());
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.queue) render();
  if (changes.automationPaused || changes.pauseReason) renderPauseBanner();
  if (changes.lastRemotePoll) renderRemoteStatus();
  if (changes.lastAutoModeFetch) renderAutoModeStatus();
});

render();
renderPauseBanner();
loadSettings();
renderRemoteStatus();
renderAutoModeStatus();
