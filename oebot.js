// oebot.js
import express from "express";
import { spawnSync } from "child_process";
import multer from "multer";
import { fileURLToPath } from "url";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  AttachmentBuilder,
  Collection
} from "discord.js";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ── __dirname for ESM ────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Persistent data directory (Render volume) ───────────────
const DATA_DIR = "/data";

// ── Ensure correct origin remote ─────────────────────────────
;(function fixOrigin() {
  try {
    const res = spawnSync("git", [
      "remote", "set-url", "origin",
      "https://github.com/Craigmuzza/ObbyEliteBot.git"   // ← semicolon removed
    ], { cwd: __dirname, stdio: "inherit" });

    console.log(res.status === 0
      ? "[git] origin remote set to correct URL"
      : "[git] failed to set origin remote");
  } catch (err) {
    console.error("[git] error setting origin remote:", err);
  }
})();

// ── Configure Git user for commits (Render doesn't set these) ─
;(function setGitIdentity() {
  try {
    spawnSync("git", ["config", "user.email", "bot@localhost"], { cwd: __dirname });
    spawnSync("git", ["config", "user.name",  "OE Loot Bot"],    { cwd: __dirname });
    console.log("[git] configured local user.name & user.email");
  } catch (err) {
    console.error("[git] error setting git identity:", err);
  }
})();

// ── Environment ───────────────────────────────────────────────
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;
const REPO               = "craigmuzza/ObbyEliteBot";
const BRANCH             = "main";
const COMMIT_MSG         = "auto: sync data";

// ── Constants & Regex ─────────────────────────────────────────
const EMBED_ICON = "https://i.imgur.com/qhpxVOw.gif";
const DEDUP_MS         = 10_000;
const COMMAND_COOLDOWN = 3_000;
const BACKUP_INTERVAL  = 5 * 60 * 1000;
const LOOT_RE = /^(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*$/i;

// ── Express + Multer setup ────────────────────────────────────
const app    = express();
const upload = multer();
app.use(express.json());
app.use(express.text({ type: "text/*" }));

// ── Discord client ────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── Bot state & storage ───────────────────────────────────────
let currentEvent = "default";
const seen       = new Map();

const events   = {
  default: { deathCounts: {}, lootTotals: {}, gpTotal: {}, kills: {} }
};

const commandCooldowns = new Collection();
const killLog = [];
const lootLog = [];

// ── Helpers ───────────────────────────────────────────────────
const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();
function parseGPString(s) {
  if (typeof s !== "string") return NaN;
  const m = s.trim().toLowerCase().match(/^([\d,.]+)([kmb])?$/);
  if (!m) return NaN;
  let n = Number(m[1].replace(/,/g, ""));
  if (isNaN(n)) return NaN;
  const suffix = m[2];
  if (suffix === "k") n *= 1e3;
  if (suffix === "m") n *= 1e6;
  if (suffix === "b") n *= 1e9;
  return n;
}

// **New**: abbreviate GP into K/M/B notation
function abbreviateGP(n) {
  if (n >= 1e9) return (n/1e9).toFixed(2).replace(/\.?0+$/,"") + "B";
  if (n >= 1e6) return (n/1e6).toFixed(2).replace(/\.?0+$/,"") + "M";
  if (n >= 1e3) return (n/1e3).toFixed(2).replace(/\.?0+$/,"") + "K";
  return String(n);
}

// ── Send an embed to a channel ────────────────────────────────
function sendEmbed(channel, title, desc, color = 0xFF0000) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(color)
	.setThumbnail(EMBED_ICON)   // ← NEW
    .setTimestamp();
  return channel.send({ embeds: [embed] });
}

// ── GitHub commit helper ───────────────────────────────────────
function commitToGitHub() {
  if (!GITHUB_PAT) return;

  let res = spawnSync("git", ["add", "."], { cwd: __dirname, stdio: "inherit" });
  if (res.status !== 0) {
    console.error("[git] Failed to stage changes");
    return;
  }

  res = spawnSync("git", ["commit", "-m", COMMIT_MSG], { cwd: __dirname, stdio: "inherit" });
  if (res.status !== 0) {
    console.warn("[git] No changes to commit");
  }

  const url = `https://x-access-token:${GITHUB_PAT}@github.com/${REPO}.git`;
  res = spawnSync("git", ["push", url, BRANCH], { cwd: __dirname, stdio: "inherit" });
  if (res.status !== 0) {
    console.error("[git] Push failed—check your PAT and URL");
    return;
  }

  console.log("[git] Successfully pushed changes");
}

// ── Save & Load data ──────────────────────────────────────────
function saveData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(DATA_DIR, "state.json"),
      JSON.stringify(
       { currentEvent, events, killLog, lootLog,},
       null,
       2
	   )
    );
    
    commitToGitHub();  // Commit the data to GitHub
  } catch (err) {
    console.error("[save] Failed to save data:", err);  // Handle any errors
  }
}

/* ── Save & Load data ───────────────────────────────────────────────── */
function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      console.log("[init] no data dir yet");
      return;
    }

 /* ── main state (events, logs, etc.) ───────────────────── */
    const statePath = path.join(DATA_DIR, "state.json");
    if (fs.existsSync(statePath)) {
      const st = JSON.parse(fs.readFileSync(statePath));
      currentEvent = st.currentEvent || "default";
      Object.assign(events, st.events || {});
      killLog.push(...(st.killLog || []));
      lootLog.push(...(st.lootLog || []));
      if (st.bounties) Object.assign(bounties, st.bounties);
      console.log("[init] loaded saved state");
    }

  } catch (err) {
    console.error("[init] Failed to load data:", err);
  }
}

// ── Rate limiting ─────────────────────────────────────────────
function checkCooldown(userId) {
  if (commandCooldowns.has(userId)) {
    const expires = commandCooldowns.get(userId) + COMMAND_COOLDOWN;
    if (now() < expires) return false;
  }
  commandCooldowns.set(userId, now());
  return true;
}

// ── Ensure event bucket exists ─────────────────────────────────
function getEventData() {
  if (!events[currentEvent]) {
    events[currentEvent] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
  }
  return events[currentEvent];
}

// ── Core processors ───────────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  try {
    // Basic validation & dedupe
    if (!killer || !victim || typeof gp !== "number" || isNaN(gp)) {
      return res.status(400).send("invalid data");
    }
    if (seen.has(dedupKey) && Date.now() - seen.get(dedupKey) < DEDUP_MS) {
      return res.status(200).send("duplicate");
    }
    seen.set(dedupKey, Date.now());

    // Update your event stats
    const { lootTotals, gpTotal, kills, deathCounts } = getEventData();
    lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
    gpTotal[ci(killer)]    = (gpTotal[ci(killer)]    || 0) + gp;
    kills[ci(killer)]      = (kills[ci(killer)]      || 0) + 1;
    deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

    // Log to your arrays for CSV exports, etc.
    lootLog.push({ killer, gp, timestamp: Date.now(), isClan: false, event: currentEvent });
    killLog.push({ killer, victim, timestamp: Date.now(), isClan: false, event: currentEvent });

    // Build & send the embed
    const totalForDisplay = currentEvent === "default"
      ? gpTotal[ci(killer)]
      : lootTotals[ci(killer)];

    const embed = new EmbedBuilder()
      .setTitle("💰 Loot Detected")
      .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields([{
        name: currentEvent === "default" ? "Total GP Earned" : "Event GP Gained",
        value: `${totalForDisplay.toLocaleString()} coins (${abbreviateGP(totalForDisplay)} GP)`,
        inline: true
      }])
      .setThumbnail(EMBED_ICON)
      .setColor(0x820000)
      .setTimestamp();

    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) {
      await ch.send({ embeds: [embed] });
    }

    // Persist & respond
    saveData();
    return res.status(200).send("ok");
  } catch (err) {
    console.error("[processLoot] Error:", err);
    return res.status(500).send("internal error");
  }
}

async function processKill(killer, victim, dedupKey, res) {
  try {
    if (!killer || !victim) {
      return res.status(400).send("invalid data");
    }
    if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS) {
      return res.status(200).send("duplicate");
    }
    seen.set(dedupKey, now());

    const isClan = registered.has(ci(killer)) && registered.has(ci(victim));
    const { deathCounts, kills } = getEventData();

    kills       [ci(killer)] = (kills       [ci(killer)]||0) + 1;
    deathCounts [ci(victim)] = (deathCounts [ci(victim)]||0) + 1;
    killLog.push({ killer, victim, timestamp: now(), isClan });

    const embed = new EmbedBuilder()
      .setTitle(isClan ? "✨ Clan Kill Logged!" : "💀 Kill Logged");
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (ch?.isTextBased()) await ch.send({ embeds: [embed] });

    saveData();
    return res.status(200).send("ok");
  } catch (err) {
    console.error("[processKill] Error:", err);
    return res.status(500).send("internal error");
  }
}

// ── HTTP Endpoints ────────────────────────────────────────────
app.post("/logLoot", (req, res) => {
  const txt = req.body?.lootMessage;
  if (!txt) return res.status(400).send("bad");
  const m = txt.match(LOOT_RE);
  if (!m) return res.status(400).send("fmt");
  return processLoot(
    m[1],
    m[2],
    Number(m[3].replace(/,/g, "")),
    txt.trim(),
    res
  );
});

app.post("/logKill", async (req, res) => {
  const { killer, victim } = req.body || {};
  if (!killer || !victim) return res.status(400).send("bad data");
  return processKill(
    killer,
    victim,
    `K|${ci(killer)}|${ci(victim)}`,
    res
  );
});

/* ─────────────────────────── RuneLite “dink” webhook ────────────────────────── */
app.post(
  "/dink",
  upload.fields([
    { name: "payload_json", maxCount: 1 },
    { name: "file",         maxCount: 1 }
  ]),
  async (req, res) => {
    // 1. Grab the raw JSON (works with multipart or plain JSON)
    let raw = req.body?.payload_json;
    if (Array.isArray(raw)) raw = raw[0];
    if (!raw && Object.keys(req.body || {}).length) {
      raw = JSON.stringify(req.body);
    }
    if (!raw) return res.status(400).send("no payload_json");

    // 2. Parse it
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(400).send("bad JSON");
    }

    // 3. Only care about clan‐chat messages
    if (
      data.type !== "CHAT" ||
      !["CLAN_CHAT", "CLAN_MESSAGE"].includes(data.extra?.type) ||
      typeof data.extra.message !== "string"
    ) {
      return res.status(204).end();
    }

    // 4. Only from our clan ("Obby Elite")
    const clanName = (data.clanName || data.extra.source || "").toLowerCase();
    if (clanName !== "obby elite") {
      return res.status(204).end();
    }

    // 5. Deduplicate on the exact loot message for 10 seconds
    const msgText  = data.extra.message.trim();
    const dedupKey = msgText;
    const nowMs    = Date.now();
    if (seen.has(dedupKey) && nowMs - seen.get(dedupKey) < DEDUP_MS) {
      return res.status(204).end();
    }
    seen.set(dedupKey, nowMs);

    // 6. Match & process loot
    const m = msgText.match(LOOT_RE);
    if (!m) {
      return res.status(204).end();
    }

    // 7. Hand off to processLoot (which will send the embed & persist)
    console.log(`[dink] seen by=${data.playerName} | msg=${msgText}`);
    await processLoot(
      m[1],                              // killer
      m[2],                              // victim
      Number(m[3].replace(/,/g, "")),    // gp
      dedupKey,                          // dedup key
      res
    );
  }
);



// ── Startup ───────────────────────────────────────────────────
loadData();
setInterval(() => {
  try {
    saveData();
  } catch (err) {
    console.error("[save] periodic save failed:", err);
  }
}, BACKUP_INTERVAL);


const port = process.env.PORT;
if (!port) {
  console.error("❌ PORT env var is required by Render");
  process.exit(1);
}
app.listen(port, () => console.log(`[http] listening on ${port}`));

// ── Time & CSV helpers ─────────────────────────────────────────
function filterByPeriod(log, period) {
  const cutoffs = {
    daily:   24*60*60*1000,
    weekly:  7*24*60*60*1000,
    monthly:30*24*60*60*1000,
    all:     Infinity
  };
  const cutoff = cutoffs[period] ?? Infinity;
  if (cutoff === Infinity) return log;
  const nowTs = now();
  return log.filter(e => nowTs - e.timestamp <= cutoff);
}

function toCSV(rows, headers) {
  const esc = v => `"${String(v).replace(/"/g,'""')}"`;
  const lines = [ headers.join(",") ];
  for (const row of rows) {
    lines.push(headers.map(h => esc(row[h])).join(","));
  }
  return lines.join("\n");
}

// ── Discord commands ─────────────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  try {
    // ignore bots & non-commands
    if (msg.author.bot) return;
    const text = msg.content.trim();
    if (!text.startsWith("!")) return;
    if (!checkCooldown(msg.author.id)) {
      return sendEmbed(msg.channel, "⏳ On Cooldown", "Please wait a few seconds between commands.");
    }

    // parse
    const lc   = text.toLowerCase();
    const args = text.split(/\s+/);
    const cmd  = args.shift();

    // ── !hiscores ────────────────────────────────────────────────
    if (cmd === "!hiscores") {
      let period = "all";
      if (args[0] && ["daily","weekly","monthly","all"].includes(args[0])) {
        period = args.shift();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;

      // filter by current event + period
      const all = filterByPeriod(
        killLog.filter(e => currentEvent === "default" ? true : e.event === currentEvent),
        period
      );

      // top-10 kills
      const makeBoard = arr => {
        const counts = {};
        arr.forEach(({ killer }) => {
          const k = killer.toLowerCase();
          if (nameFilter && k !== nameFilter) return;
          counts[k] = (counts[k]||0) + 1;
        });
        return Object.entries(counts)
          .sort((a,b) => b[1] - a[1])
          .slice(0,10)
          .map(([n,v],i) => ({ rank: i+1, name: n, kills: v }));
      };
      const normalBoard = makeBoard(all);

      // dynamic title
      const title =
        `🏆 Hiscores (${period})` +
        (currentEvent !== "default" ? ` — Event: ${currentEvent}` : "");

      // build + send embed
      const e1 = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x004200)
        .setThumbnail(EMBED_ICON)
        .setTimestamp();
      if (!normalBoard.length) {
        e1.setDescription("No kills in that period.");
      } else {
        normalBoard.forEach(r =>
          e1.addFields({
            name:  `${r.rank}. ${r.name}`,
            value: `Kills: ${r.kills}`,
            inline: false
          })
        );
      }
      return msg.channel.send({ embeds: [e1] });
    }

    // ── !totalgp / !totalloot ────────────────────────────────────
    if (cmd === "!totalgp" || cmd === "!totalloot") {
      const { gpTotal } = getEventData();
      const totalGP = Object.values(gpTotal).reduce((s,g) => s+g, 0);
      return sendEmbed(
        msg.channel,
        "💰 Total Loot",
        `Total GP across all players: **${totalGP.toLocaleString()} coins (${abbreviateGP(totalGP)} GP)**`
      );
    }

    // ── !lootboard ────────────────────────────────────────────────
    if (cmd === "!lootboard") {
      let period = "all";
      if (args[0] && ["daily","weekly","monthly","all"].includes(args[0])) {
        period = args.shift();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;

      // filter by current event + period, drop clan
      const all = filterByPeriod(
        lootLog.filter(e => currentEvent === "default" ? true : e.event === currentEvent),
        period
      ).filter(e => !e.isClan);

      // top-10 GP
      const makeLootBoard = arr => {
        const sums = {};
        arr.forEach(({ killer, gp }) => {
          const k = killer.toLowerCase();
          if (nameFilter && k !== nameFilter) return;
          sums[k] = (sums[k]||0) + gp;
        });
        return Object.entries(sums)
          .sort((a,b) => b[1] - a[1])
          .slice(0,10)
          .map(([n,v],i) => ({ rank: i+1, name: n, gp: v }));
      };
      const normalBoard = makeLootBoard(all);

      // dynamic title
      const title =
        `💰 Lootboard (${period})` +
        (currentEvent !== "default" ? ` — Event: ${currentEvent}` : "");

      // build + send embed
      const e1 = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x004200)
        .setThumbnail(EMBED_ICON)
        .setTimestamp();
      if (!normalBoard.length) {
        e1.setDescription("No loot in that period.");
      } else {
        normalBoard.forEach(r =>
          e1.addFields({
            name:  `${r.rank}. ${r.name}`,
            value: `${r.gp.toLocaleString()} coins (${abbreviateGP(r.gp)})`,
            inline: false
          })
        );
      }
      return msg.channel.send({ embeds: [e1] });
    }

    // ── Events & helper commands ─────────────────────────────────
    if (lc === "!listevents") {
      return sendEmbed(
        msg.channel,
        "📅 Events",
        Object.keys(events)
          .map(e => `• ${e}${e === currentEvent ? " (current)" : ""}`)
          .join("\n")
      );
    }
    if (lc.startsWith("!createevent ")) {
      const name = text.slice(13).trim();
      if (!name || events[name]) {
        return sendEmbed(msg.channel, "⚠️ Event Error", "Invalid or duplicate event name.");
      }
      events[name] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
      currentEvent = name; saveData();
      return sendEmbed(msg.channel, "📅 Event Created", `**${name}** is now current.`);
    }
    if (lc === "!finishevent") {
      const file = `events/event_${currentEvent}_${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
      fs.mkdirSync(path.dirname(path.join(__dirname,file)), { recursive:true });
      fs.writeFileSync(path.join(__dirname,file), JSON.stringify(events[currentEvent],null,2));
      await commitToGitHub();
      delete events[currentEvent];
      currentEvent = "default";
      saveData();
      return sendEmbed(msg.channel, "✅ Event Finished", `Saved to \`${file}\`, back to **default**.`);
    }
    if (cmd === "!resetall") {
      // wipe logs & events
      killLog.length = 0;
      lootLog.length = 0;
      for (const ev in events) delete events[ev];
      events.default = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
      currentEvent   = "default";
      saveData();
      return sendEmbed(msg.channel, "🔄 Reset Complete", "All hiscores and lootboard data have been wiped and reset to default.");
    }
    if (lc === "!help") {
      const help = new EmbedBuilder()
        .setTitle("🛠 OE Loot Bot Help")
        .setColor(0x004200)
        .setThumbnail(EMBED_ICON)
        .setTimestamp()
        .addFields([
          { name: "Stats", value: "`!hiscores [period]`\n`!lootboard [period]`\n`!totalgp`", inline:false },
          { name: "Misc",  value:"`!help`", inline:false }
        ]);
      return msg.channel.send({ embeds: [help] });
    }

  } catch (err) {
    console.error("[command] Error handling command:", err);
    return sendEmbed(msg.channel, "⚠️ Error", "An error occurred while processing your command.");
  }
});



client.once("ready", () => console.log(`[discord] ready: ${client.user.tag}`));
client.on("error", err => console.error("[discord] Client error:", err));
client.on("disconnect", () => console.log("[discord] Client disconnected"));

client.login(DISCORD_BOT_TOKEN).catch(err => {
  console.error("[discord] Failed to login:", err);
  process.exit(1);
});