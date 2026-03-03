require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0"
  }
});
const STATE_FILE = path.join(__dirname, "seenWebJobs.json");
const KEYWORDS_FILE = path.join(__dirname, "keywords.json");

const DEFAULT_POLL_SECONDS = 60;
const DEFAULT_MAX_POST_AGE_HOURS = 24;
const DEFAULT_MAX_ALERTS_PER_CYCLE = 5;
const MAX_SEEN = 3000;

const WWR_FEEDS = [
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-marketing-jobs.rss",
  "https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss"
];

const JOBPRESSO_RSS = "https://jobspresso.co/remote-work/feed/";
const AGGREGATOR_QUERY_GROUPS = [
  "\"campaign manager\"",
  "(\"clay operator\" OR \"clay specialist\" OR \"clay consultant\" OR \"clay expert\" OR \"clay builder\" OR \"clay automation\" OR \"clay workflows\" OR \"clay gtm\")",
  "(\"revenue operations manager\" OR \"revops engineer\" OR \"growth operations manager\" OR \"outbound operations manager\" OR \"marketing operations manager\")",
  "(\"gtm engineer\" OR \"go to market engineer\" OR \"revenue operations engineer\" OR \"growth operations engineer\")"
];
const AGGREGATOR_SITE_FILTER =
  "(site:jooble.org OR site:adzuna.com OR site:talent.com OR site:indeed.com OR site:bebee.com OR site:jobvite.com OR site:cutshort.io OR site:uplers.com OR site:recruiterflow.com OR site:jobzmall.com OR site:jobaaj.com OR site:trabajo.org OR site:efinancialcareers.com)";

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function getKeywords() {
  const keywords = readJson(KEYWORDS_FILE, []);
  if (!Array.isArray(keywords) || keywords.length === 0) {
    throw new Error("keywords.json is empty or invalid");
  }
  return keywords.map(normalize).filter(Boolean);
}

function getLocalDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readState() {
  const data = readJson(STATE_FILE, { bootstrapped: false, seen: [], stats: {} });
  const stats = data.stats && typeof data.stats === "object" ? data.stats : {};
  return {
    bootstrapped: Boolean(data.bootstrapped),
    seen: Array.isArray(data.seen) ? data.seen : [],
    stats: {
      date: typeof stats.date === "string" ? stats.date : "",
      cyclesToday: Number(stats.cyclesToday || 0),
      matchedToday: Number(stats.matchedToday || 0),
      sentToday: Number(stats.sentToday || 0),
      lastSummaryDate: typeof stats.lastSummaryDate === "string" ? stats.lastSummaryDate : ""
    }
  };
}

function trimSeen(seen) {
  return seen.length > MAX_SEEN ? seen.slice(-MAX_SEEN) : seen;
}

function writeState(state) {
  writeJson(STATE_FILE, {
    bootstrapped: Boolean(state.bootstrapped),
    seen: trimSeen(state.seen || []),
    stats: state.stats || {}
  });
}

function rollStatsDate(stats) {
  const today = getLocalDateKey();
  if (stats.date !== today) {
    return {
      ...stats,
      date: today,
      cyclesToday: 0,
      matchedToday: 0,
      sentToday: 0
    };
  }
  return stats;
}

function getItemText(item) {
  return normalize([
    item.title,
    item.company,
    item.location,
    item.tags ? item.tags.join(" ") : "",
    item.summary,
    item.description
  ].filter(Boolean).join(" "));
}

function getMatchedKeywords(text, keywords) {
  return keywords.filter((k) => text.includes(k));
}

function isRemoteText(text) {
  const terms = ["remote", "work from home", "wfh", "anywhere", "distributed", "worldwide"];
  return terms.some((t) => text.includes(t));
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function withinAge(item, maxAgeHours) {
  const d = parseDate(item.publishedAt);
  if (!d) return false;
  const age = Date.now() - d.getTime();
  return age >= 0 && age <= maxAgeHours * 60 * 60 * 1000;
}

function itemKey(item) {
  return item.id || item.link;
}

function formatMessage(item, matchedKeywords) {
  return [
    `Web Job Alert [${item.source}]`,
    "",
    `Title: ${item.title || "Job"}`,
    item.company ? `Company: ${item.company}` : null,
    item.location ? `Location: ${item.location}` : null,
    matchedKeywords.length ? `Matched: ${matchedKeywords.join(", ")}` : null,
    item.publishedAt ? `Published: ${item.publishedAt}` : null,
    `Link: ${item.link}`
  ].filter(Boolean).join("\n");
}

async function sendTelegram(message) {
  if (process.env.DRY_RUN === "1") return true;

  const token = (process.env.BOT_TOKEN || "").trim();
  const groupId = (process.env.GROUP_ID || "").trim();
  if (!token || !groupId) throw new Error("BOT_TOKEN or GROUP_ID missing");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  for (let i = 0; i < 3; i += 1) {
    try {
      await axios.post(url, { chat_id: groupId, text: message, disable_web_page_preview: true }, { timeout: 20000 });
      return true;
    } catch (err) {
      const retryAfter = err.response?.data?.parameters?.retry_after;
      if (err.response?.status === 429 && retryAfter) {
        await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      } else if (i === 2) {
        console.log("Telegram send failed:", err.response?.data || err.message);
        return false;
      }
    }
  }
  return false;
}

async function maybeSendStartupPing() {
  const enabled = parseBoolean(process.env.STARTUP_PING, true);
  if (!enabled || process.env.DRY_RUN === "1") return;
  const text = process.env.STARTUP_PING_TEXT || "Web jobs notifier is live.";
  await sendTelegram(text);
}

async function maybeSendDailySummary(state) {
  const enabled = parseBoolean(process.env.DAILY_SUMMARY, true);
  if (!enabled || process.env.DRY_RUN === "1") return;

  const hour = Number(process.env.SUMMARY_HOUR || 22);
  const minute = Number(process.env.SUMMARY_MINUTE || 0);
  const now = new Date();
  const today = getLocalDateKey();

  if (state.stats.lastSummaryDate === today) return;
  if (now.getHours() < hour) return;
  if (now.getHours() === hour && now.getMinutes() < minute) return;

  const msg = [
    "Web Jobs Daily Summary",
    `Date: ${today}`,
    `Cycles run: ${state.stats.cyclesToday}`,
    `Matched items: ${state.stats.matchedToday}`,
    `Alerts sent: ${state.stats.sentToday}`
  ].join("\n");

  const ok = await sendTelegram(msg);
  if (ok) {
    state.stats.lastSummaryDate = today;
    writeState(state);
  }
}

async function fetchRemotive() {
  try {
    const { data } = await axios.get("https://remotive.com/api/remote-jobs", { timeout: 25000 });
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    return jobs.map((j) => ({
      id: `remotive:${j.id}`,
      source: "Remotive",
      title: j.title || "",
      company: j.company_name || "",
      location: j.candidate_required_location || "",
      tags: Array.isArray(j.tags) ? j.tags : [],
      summary: j.job_type || "",
      description: j.description || "",
      link: j.url || "",
      publishedAt: j.publication_date || ""
    }));
  } catch (err) {
    console.log("Remotive fetch failed:", err.message);
    return [];
  }
}

async function fetchRemoteOK() {
  try {
    const { data } = await axios.get("https://remoteok.com/api", {
      timeout: 25000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const rows = Array.isArray(data) ? data.filter((x) => x && x.id) : [];
    return rows.map((j) => ({
      id: `remoteok:${j.id}`,
      source: "RemoteOK",
      title: j.position || j.title || "",
      company: j.company || "",
      location: j.location || "Remote",
      tags: Array.isArray(j.tags) ? j.tags : [],
      summary: "",
      description: j.description || "",
      link: j.url ? `https://remoteok.com${j.url}` : "",
      publishedAt: j.date || (j.epoch ? new Date(j.epoch * 1000).toISOString() : "")
    }));
  } catch (err) {
    console.log("RemoteOK fetch failed:", err.message);
    return [];
  }
}

async function fetchRssSource(url, sourceName) {
  try {
    const feed = await Promise.race([
      parser.parseURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error("RSS timeout")), 18000))
    ]);
    const items = Array.isArray(feed.items) ? feed.items : [];
    return items.map((i) => ({
      id: `${sourceName}:${i.guid || i.link}`,
      source: sourceName,
      title: i.title || "",
      company: "",
      location: "Remote",
      tags: [],
      summary: i.contentSnippet || "",
      description: i.content || "",
      link: i.link || "",
      publishedAt: i.isoDate || i.pubDate || ""
    }));
  } catch (err) {
    console.log(`${sourceName} RSS failed:`, err.message);
    return [];
  }
}

async function fetchAggregatorFeeds() {
  const urls = AGGREGATOR_QUERY_GROUPS.map((q) => {
    const query = `${AGGREGATOR_SITE_FILTER} (${q}) (remote OR \"work from home\") when:1d`;
    return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  });

  const batches = await Promise.all(urls.map((u) => fetchRssSource(u, "GoogleJobsAggregators")));
  return batches.flat();
}

async function fetchAllSources() {
  const [remotive, remoteok, wwr1, wwr2, wwr3, jobspresso, aggregators] = await Promise.all([
    fetchRemotive(),
    fetchRemoteOK(),
    fetchRssSource(WWR_FEEDS[0], "WeWorkRemotely"),
    fetchRssSource(WWR_FEEDS[1], "WeWorkRemotely"),
    fetchRssSource(WWR_FEEDS[2], "WeWorkRemotely"),
    fetchRssSource(JOBPRESSO_RSS, "Jobspresso"),
    fetchAggregatorFeeds()
  ]);

  return [...remotive, ...remoteok, ...wwr1, ...wwr2, ...wwr3, ...jobspresso, ...aggregators]
    .filter((x) => x.link)
    .map((x) => ({ ...x, link: x.link.replace(/&amp;/g, "&") }));
}

async function runCycle() {
  const keywords = getKeywords();
  const state = readState();
  state.stats = rollStatsDate(state.stats);

  const requireRemote = parseBoolean(process.env.REQUIRE_REMOTE, true);
  const maxAge = Number(process.env.MAX_POST_AGE_HOURS || DEFAULT_MAX_POST_AGE_HOURS) || DEFAULT_MAX_POST_AGE_HOURS;
  const maxAlerts = Number(process.env.MAX_ALERTS_PER_CYCLE || DEFAULT_MAX_ALERTS_PER_CYCLE) || DEFAULT_MAX_ALERTS_PER_CYCLE;

  console.log(`Checking web sources at ${new Date().toISOString()} | remote=${requireRemote} | maxAgeHours=${maxAge}`);

  const all = await fetchAllSources();
  const dedupe = new Map();
  for (const item of all) {
    const key = (item.link || "").split("?")[0] || itemKey(item);
    if (!dedupe.has(key)) dedupe.set(key, item);
  }

  const items = [...dedupe.values()].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const seenSet = new Set(state.seen);

  if (!state.bootstrapped) {
    const keys = items.map(itemKey).filter(Boolean);
    writeState({ ...state, bootstrapped: true, seen: keys });
    console.log(`Bootstrapped with ${keys.length} existing items. Alerts start next cycle.`);
    return;
  }

  const stats = { total: items.length, seen: 0, keywordMiss: 0, remoteMiss: 0, ageMiss: 0, matched: 0 };
  const newSeen = [...state.seen];
  let sent = 0;

  for (const item of items) {
    const key = itemKey(item);
    if (!key || seenSet.has(key)) {
      stats.seen += 1;
      continue;
    }

    const text = getItemText(item);
    const matched = getMatchedKeywords(text, keywords);

    if (matched.length === 0) {
      stats.keywordMiss += 1;
      continue;
    }
    if (requireRemote && !isRemoteText(text)) {
      stats.remoteMiss += 1;
      continue;
    }
    if (!withinAge(item, maxAge)) {
      stats.ageMiss += 1;
      continue;
    }

    stats.matched += 1;
    const msg = formatMessage(item, matched);

    if (process.env.DRY_RUN === "1") {
      console.log(`DRY_RUN alert [${item.source}]:`, item.title);
      sent += 1;
      seenSet.add(key);
      newSeen.push(key);
      if (sent >= maxAlerts) break;
      continue;
    }

    const ok = await sendTelegram(msg);
    if (ok) {
      sent += 1;
      seenSet.add(key);
      newSeen.push(key);
      if (sent >= maxAlerts) break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  state.stats.cyclesToday += 1;
  state.stats.matchedToday += stats.matched;
  state.stats.sentToday += sent;

  writeState({ ...state, bootstrapped: true, seen: newSeen });
  await maybeSendDailySummary({ ...state, bootstrapped: true, seen: newSeen });

  console.log(`Cycle stats: total=${stats.total}, seen=${stats.seen}, keywordMiss=${stats.keywordMiss}, remoteMiss=${stats.remoteMiss}, ageMiss=${stats.ageMiss}, matched=${stats.matched}, sent=${sent}`);
  console.log(sent ? `Sent ${sent} alert(s).` : "No new matched alerts.");
}

async function start() {
  const pollSeconds = Number(process.env.POLL_SECONDS || DEFAULT_POLL_SECONDS) || DEFAULT_POLL_SECONDS;
  await maybeSendStartupPing();
  await runCycle();
  if (process.env.RUN_ONCE === "1") {
    process.exit(0);
    return;
  }
  setInterval(() => runCycle().catch((e) => console.log("Cycle error:", e.message)), pollSeconds * 1000);
  console.log(`Web job notifier running. Poll every ${pollSeconds}s.`);
}

start().catch((err) => {
  console.error("Startup error:", err.message);
  process.exit(1);
});
