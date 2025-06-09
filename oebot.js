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

// track which raw chat lines we've already handed to processLoot
const processedLoot = new Set();

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
const seenByLog = [];

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
function sendEmbed(channel, title, desc, color = 0x004200) {
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

   fs.writeFileSync(path.join(DATA_DIR, "state.json"),
     JSON.stringify({
       currentEvent, events, killLog, lootLog, seenByLog
     }, null, 2)
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
      if (Array.isArray(st.seenByLog)) seenByLog.push(...st.seenByLog);
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

// ── add these near the top, alongside your other constants ─────
const GOLD_THRESHOLD = 10_000_000;
const COLOR_NORMAL  = 0x820000;
const COLOR_GOLD    = 0xFFD700;  // “gold”


async function processLoot(killer, victim, gp, dedupKey, res) {
  try {
    // 1) Validate & de-dupe
    if (!killer || !victim || typeof gp !== "number" || isNaN(gp)) {
      return res.status(400).send("invalid data");
    }
    if (seen.has(dedupKey) && Date.now() - seen.get(dedupKey) < DEDUP_MS) {
      return res.status(200).send("duplicate");
    }
    seen.set(dedupKey, Date.now());

    // 2) Update stats
    const { lootTotals, gpTotal, kills, deathCounts } = getEventData();
    lootTotals[ci(killer)] = (lootTotals[ci(killer)] || 0) + gp;
    gpTotal[ci(killer)]    = (gpTotal[ci(killer)]    || 0) + gp;
    kills[ci(killer)]      = (kills[ci(killer)]      || 0) + 1;
    killLog.push({ killer, victim, gp, timestamp: Date.now(), event: currentEvent });
    deathCounts[ci(victim)] = (deathCounts[ci(victim)] || 0) + 1;

    // ← PUSH INTO lootLog so !lootboard will have data
    lootLog.push({
      killer,
      gp,
      timestamp: now(),
      isClan: false,           // or your real is-clan check
      event: currentEvent
    });

    // 3) Build & send embed
    const total = currentEvent === "default"
      ? gpTotal[ci(killer)]
      : lootTotals[ci(killer)];

    // pick gold vs normal
    const color = gp >= GOLD_THRESHOLD ? COLOR_GOLD : COLOR_NORMAL;

    const embed = new EmbedBuilder()
      .setTitle("💰 Loot Detected")
      .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields({
        name:  currentEvent === "default" ? "Total GP Earned" : "Event GP Gained",
        value: `${total.toLocaleString()} coins (${abbreviateGP(total)} GP)`,
        inline: true
      })
      .setColor(color)
      .setThumbnail(EMBED_ICON)
      .setTimestamp();

    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!ch) {
      console.error("[processLoot] ❌ channel not found");
    } else {
      try {
        await ch.send({ embeds: [embed] });
      } catch (sendErr) {
        console.error("[processLoot] ❌ failed to send embed:", sendErr);
      }
    }

    // 4) Persist & finish
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
	
	lootLog.push({
	  killer,
	  gp,
	  timestamp: now(),       // or Date.now()
	  isClan: false,          // if you want clan-only vs public
	  event: currentEvent
	});

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
    // 1. grab & parse raw JSON
    let raw = req.body?.payload_json;
    if (Array.isArray(raw)) raw = raw[0];
    if (!raw && Object.keys(req.body || {}).length) raw = JSON.stringify(req.body);
    if (!raw) return res.status(400).send("no payload_json");

    let data;
    try { data = JSON.parse(raw); }
    catch { return res.status(400).send("bad JSON"); }

    // 2. only clan chat text
    if (
      data.type       !== "CHAT" ||
      !["CLAN_CHAT","CLAN_MESSAGE"].includes(data.extra?.type) ||
      typeof data.extra.message !== "string"
    ) {
      return res.status(204).end();
    }
    if ((data.clanName||data.extra.source||"").toLowerCase() !== "obby elite") {
      return res.status(204).end();
    }

    // 3. match loot line
    const msgText = data.extra.message.trim();
    const m = msgText.match(LOOT_RE);
    if (!m) return res.status(204).end();

    // 4. DE-DUPE: if we've already processed this exact raw line, bail
    if (processedLoot.has(msgText)) {
      return res.status(204).end();
    }
    processedLoot.add(msgText);

    // 5. record who saw it
    const rsn = data.playerName || "unknown";
    seenByLog.push({ player: rsn, message: msgText, timestamp: Date.now() });
    console.log(`[dink] seen by=${rsn} | ⚔️  saw loot message: ${msgText}`);

    // 6. process it once
    console.log(`[dink] ⚔️  processing loot message: ${msgText}`);
    await processLoot(
      m[1],                               // killer
      m[2],                               // victim
      Number(m[3].replace(/,/g, "")),     // gp
      msgText,                            // dedupKey
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
    // 1) ignore bots
    if (msg.author.bot) return;

    // 2) only care about commands
    const text = msg.content.trim();
    if (!text.startsWith("!")) return;

    // 3) immediately delete the original command message
    msg.delete().catch(() => {});

    // 4) rate-limit
    if (!checkCooldown(msg.author.id)) {
      return sendEmbed(msg.channel, "⏳ On Cooldown", "Please wait a few seconds between commands.");
    }

    // 5) parse command + args
    const parts = text.slice(1).split(/\s+/);
    const cmd   = parts.shift().toLowerCase();
    const args  = parts;

    // ── !hiscores ────────────────────────────────────────────────
    if (cmd === "hiscores") {
      let period = "all";
      if (args[0] && ["daily","weekly","monthly","all"].includes(args[0])) {
        period = args.shift();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;

      const allKills = filterByPeriod(
        killLog.filter(e => currentEvent === "default" ? true : e.event === currentEvent),
        period
      );
      const counts = {};
      allKills.forEach(({ killer }) => {
        const k = killer.toLowerCase();
        if (nameFilter && k !== nameFilter) return;
        counts[k] = (counts[k]||0) + 1;
      });
      const board = Object.entries(counts)
        .sort((a,b) => b[1] - a[1])
        .slice(0,10)
        .map(([n,v],i) => ({ rank: i+1, name: n, kills: v }));

      const title = `🏆 Hiscores (${period})` +
        (currentEvent !== "default" ? ` — Event: ${currentEvent}` : "");
      const e1 = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x004200)
        .setThumbnail(EMBED_ICON)
        .setTimestamp();
      if (!board.length) {
        e1.setDescription("No kills in that period.");
      } else {
        board.forEach(r =>
          e1.addFields({ name: `${r.rank}. ${r.name}`, value: `Kills: ${r.kills}`, inline: false })
        );
      }
      return msg.channel.send({ embeds: [e1] });
    }

    // ── !totalgp / !totalloot ────────────────────────────────────
    if (cmd === "totalgp" || cmd === "totalloot") {
      const { gpTotal } = getEventData();
      const totalGP = Object.values(gpTotal).reduce((s,g) => s+g, 0);
      return sendEmbed(
        msg.channel,
        "💰 Total Loot",
        `Total GP across all players: **${totalGP.toLocaleString()} coins (${abbreviateGP(totalGP)} GP)**`
      );
    }

    // ── !lootboard ────────────────────────────────────────────────
    if (cmd === "lootboard") {
      let period = "all";
      if (args[0] && ["daily","weekly","monthly","all"].includes(args[0])) {
        period = args.shift();
      }
      const nameFilter = args.join(" ").toLowerCase() || null;

      const allLoot = filterByPeriod(
        lootLog.filter(e => currentEvent === "default" ? true : e.event === currentEvent),
        period
      ).filter(e => !e.isClan);
      const sums = {};
      allLoot.forEach(({ killer, gp }) => {
        const k = killer.toLowerCase();
        if (nameFilter && k !== nameFilter) return;
        sums[k] = (sums[k]||0) + gp;
      });
      const board = Object.entries(sums)
        .sort((a,b) => b[1] - a[1])
        .slice(0,10)
        .map(([n,v],i) => ({ rank: i+1, name: n, gp: v }));

      const title = `💰 Lootboard (${period})` +
        (currentEvent !== "default" ? ` — Event: ${currentEvent}` : "");
      const e2 = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x004200)
        .setThumbnail(EMBED_ICON)
        .setTimestamp();
      if (!board.length) {
        e2.setDescription("No loot in that period.");
      } else {
        board.forEach(r =>
          e2.addFields({ name: `${r.rank}. ${r.name}`, value: `${r.gp.toLocaleString()} coins (${abbreviateGP(r.gp)})`, inline: false })
        );
      }
      return msg.channel.send({ embeds: [e2] });
    }

    // ── !listevents ──────────────────────────────────────────────
    if (cmd === "listevents") {
      return sendEmbed(
        msg.channel,
        "📅 Events",
        Object.keys(events)
          .map(e => `• ${e}${e === currentEvent ? " (current)" : ""}`)
          .join("\n")
      );
    }

    // ── !createevent <name> ──────────────────────────────────────
    if (cmd === "createevent") {
      const name = args.join(" ").trim();
      if (!name || events[name]) {
        return sendEmbed(msg.channel, "⚠️ Event Error", "Invalid or duplicate event name.");
      }
      events[name]  = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
      currentEvent = name;
      saveData();
      return sendEmbed(msg.channel, "📅 Event Created", `**${name}** is now current.`);
    }

    // ── !finishevent ────────────────────────────────────────────
    if (cmd === "finishevent") {
      const file = `events/event_${currentEvent}_${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
      fs.mkdirSync(path.dirname(path.join(__dirname,file)), { recursive:true });
      fs.writeFileSync(path.join(__dirname,file), JSON.stringify(events[currentEvent],null,2));
      await commitToGitHub();
      delete events[currentEvent];
      currentEvent = "default";
      saveData();
      return sendEmbed(msg.channel, "✅ Event Finished", `Saved to \`${file}\`, back to **default**.`);
    }

    // ── !reset <player> ─────────────────────────────────────────
    if (cmd === "reset") {
      const target = args.join(" ").toLowerCase();
      if (!target) {
        return sendEmbed(msg.channel, "⚠️ Usage", "`!reset <player>`");
      }
      // remove from current event
      const ev = getEventData();
      delete ev.kills[target];
      delete ev.lootTotals[target];
      delete ev.gpTotal[target];
      delete ev.deathCounts[target];
      // purge logs
      killLog.splice(0, killLog.length, ...killLog.filter(e =>
        e.killer.toLowerCase() !== target && e.victim.toLowerCase() !== target
      ));
      lootLog.splice(0, lootLog.length, ...lootLog.filter(e =>
        e.killer.toLowerCase() !== target
      ));
      saveData();
      return sendEmbed(msg.channel, "🔄 Player Reset", `Stats for **${target}** wiped.`);
    }

    // ── !resetall ───────────────────────────────────────────────
    if (cmd === "resetall") {
      killLog.length = 0;
      lootLog.length = 0;
      Object.keys(events).forEach(ev => delete events[ev]);
      events.default = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
      currentEvent   = "default";
      saveData();
      return sendEmbed(msg.channel, "🔄 Reset Complete", "All data wiped.");
    }

    // ── !seenby ────────────────────────────────────────────────
    if (cmd === "seenby") {
      let count = Number(args[0]);
      if (isNaN(count) || count < 1) count = 10;
      const slice = seenByLog.slice(-count);
      if (!slice.length) {
        return sendEmbed(msg.channel, "👀 Seen By", "No viewers recorded yet.");
      }
      const names = [...new Set(slice.map(e => e.player))];
      return sendEmbed(
        msg.channel,
        `👀 Seen By (${names.length})`,
        names.join(", ")
      );
    }

    // ── !help ─────────────────────────────────────────────────
    if (cmd === "help") {
      const help = new EmbedBuilder()
        .setTitle("🛠 OE Loot Bot Help")
        .setColor(0x004200)
        .setThumbnail(EMBED_ICON)
        .setTimestamp()
        .addFields([
          { name: "Stats", value: "`!hiscores [period]`\n`!lootboard [period]`\n`!totalgp`", inline:false },
          { name: "Events", value: "`!listevents`\n`!createevent <name>`\n`!finishevent`", inline:false },
          { name: "Reset", value: "`!reset <player>`\n`!resetall`", inline:false },
          { name: "Misc", value: "`!seenby [count]`\n`!help`", inline:false }
        ]);
      return msg.channel.send({ embeds: [help] });
    }

  } catch (err) {
    console.error("[command] handler error:", err);
    sendEmbed(msg.channel, "⚠️ Error", "Something went wrong.");
  }
});

client.once("ready", () => console.log(`[discord] ready: ${client.user.tag}`));
client.on("error", err => console.error("[discord] Client error:", err));
client.on("disconnect", () => console.log("[discord] Client disconnected"));

client.login(DISCORD_BOT_TOKEN).catch(err => {
  console.error("[discord] Failed to login:", err);
  process.exit(1);
});