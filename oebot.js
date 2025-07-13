// oebot.js – full, working version  ░░ 2025-06-11
/* eslint-disable no-multi-spaces */

// ─── std-lib & deps ──────────────────────────────────────────
import express                    from "express";
import { spawn, spawnSync }       from "child_process";
import multer                     from "multer";
import fs                         from "fs";
import path                       from "path";
import { fileURLToPath }          from "url";
import dotenv                     from "dotenv";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  Collection
}                                 from "discord.js";
dotenv.config();

// ─── paths & dirs ────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DATA_DIR   = "/data";

// ─── Git remote & identity (safe-guard) ─────────────────────
function gitRemoteExists() {
  try {
    const out = spawnSync("git", ["remote"], { cwd: __dirname })
                  .stdout.toString();
    return out.split(/\s+/).includes("origin");
  } catch { return false; }
}
if (gitRemoteExists()) {
  spawnSync("git",
    ["remote", "set-url", "origin",
     "https://github.com/Craigmuzza/ObbyEliteBot.git"],
    { cwd: __dirname, stdio: "ignore" });
}
spawnSync("git", ["config", "user.email", "bot@localhost" ], { cwd: __dirname });
spawnSync("git", ["config", "user.name",  "OE Loot Bot"    ], { cwd: __dirname });

// ─── env ─────────────────────────────────────────────────────
const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  GITHUB_PAT
} = process.env;
const REPO   = "craigmuzza/ObbyEliteBot";
const BRANCH = "main";
const COMMIT_MSG = "auto: sync data";

// ─── constants ───────────────────────────────────────────────
const EMBED_ICON      = "https://i.imgur.com/qhpxVOw.gif";
const DEDUP_MS        = 10_000;
const COMMAND_COOLDOWN= 3_000;
const BACKUP_INTERVAL = 5 * 60_000;       // 5 min
const GOLD_THRESHOLD  = 10_000_000;
const COLOR_NORMAL    = 0x820000;
const COLOR_GOLD      = 0xFFD700;
const LOOT_RE =
  /^(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\(\s*([\d,]+)\s*coins\).*$/i;

// ─── runtime state ───────────────────────────────────────────
let currentEvent = "default";
const processedLoot = new Set();     // de-dupe /dink raw lines
const seen          = new Map();     // short anti-spam window
const events   = { default:{ deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} }};
const killLog  = [];
const lootLog  = [];
const seenByLog= [];
const commandCooldowns = new Collection();

// ─── tiny helpers ────────────────────────────────────────────
const ci  = s => (s ?? "").toLowerCase().trim();
const now = () => Date.now();
const abbreviateGP = n =>
  n>=1e9 ? (n/1e9).toFixed(2).replace(/\.?0+$/,"")+"B" :
  n>=1e6 ? (n/1e6).toFixed(2).replace(/\.?0+$/,"")+"M" :
  n>=1e3 ? (n/1e3).toFixed(2).replace(/\.?0+$/,"")+"K" : String(n);

// convert "123", "123k", "2.5m" → Number
function parseGP(str) {
  if (typeof str !== "string") return NaN;
  const m = str.trim().toLowerCase().match(/^([\d.,]+)\s*([kmb])?$/);
  if (!m) return NaN;
  let n = Number(m[1].replace(/,/g, ""));
  if (isNaN(n)) return NaN;
  const suf = m[2];
  if (suf === "k") n *= 1e3;
  if (suf === "m") n *= 1e6;
  if (suf === "b") n *= 1e9;
  return n;
}

function checkCooldown(id) {
  const nxt = commandCooldowns.get(id) || 0;
  if (now() < nxt) return false;
  commandCooldowns.set(id, now() + COMMAND_COOLDOWN);
  return true;
}

const sendEmbed = (ch, title, desc, color = 0x004200) =>
  ch.send({ embeds: [ new EmbedBuilder()
      .setTitle(title).setDescription(desc).setColor(color)
      .setThumbnail(EMBED_ICON).setTimestamp() ]});

// ─── git helper (debounced push) ─────────────────────────────
let gitTimer = null;
function queueGitCommit() {
  if (!GITHUB_PAT) return;
  if (gitTimer) return;

  gitTimer = setTimeout(() => {
    gitTimer = null;
    const opts = { cwd: __dirname, stdio: "ignore", detached: true };
    spawnSync("git", ["add", "."], opts);
    spawnSync("git", ["commit", "-m", COMMIT_MSG], opts);
    spawnSync("git", ["pull", "--rebase", "--ff-only"], opts);
    spawn("git", ["push",
      `https://x-access-token:${GITHUB_PAT}@github.com/${REPO}.git`,
      BRANCH], opts).unref();
  }, 5 * 60_000);
}

// ─── persistence ────────────────────────────────────────────
function saveData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive:true });
    fs.writeFileSync(
      path.join(DATA_DIR, "state.json"),
      JSON.stringify({ currentEvent, events, killLog, lootLog, seenByLog }, null, 2)
    );
    queueGitCommit();
  } catch (e) { console.error("[save] failed:", e); }
}
function loadData() {
  try {
    const p = path.join(DATA_DIR, "state.json");
    if (!fs.existsSync(p)) return;
    const d = JSON.parse(fs.readFileSync(p));
    currentEvent = d.currentEvent ?? "default";
    Object.assign(events,   d.events   ?? {});
    killLog .push(...(d.killLog  ?? []));
    lootLog .push(...(d.lootLog  ?? []));
    seenByLog.push(...(d.seenByLog?? []));
    console.log("[init] state loaded");
  } catch (e) { console.error("[init] load error:", e); }
}

// ─── discord client ─────────────────────────────────────────
const client = new Client({
  intents:[ GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent ]
});
let discordReady = false;
client.once("ready", () => {
  discordReady = true;
  console.log(`[discord] ready: ${client.user.tag}`);
});
client.on("error", e => console.error("[discord] error:", e));

// ─── helpers for event bucket ────────────────────────────────
function getEventData() {
  if (!events[currentEvent])
    events[currentEvent] = { deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} };
  return events[currentEvent];
}

// ─── main loot processor ─────────────────────────────────────
async function processLoot(killer, victim, gp, dedupKey, res) {
  try {
    if (!killer || !victim || isNaN(gp))
      return res?.status(400).send("bad data");
    if (seen.has(dedupKey) && now() - seen.get(dedupKey) < DEDUP_MS)
      return res?.status(200).send("dup");
    seen.set(dedupKey, now());

    const ev = getEventData();
    ev.lootTotals[ci(killer)] = (ev.lootTotals[ci(killer)] ?? 0) + gp;
    ev.gpTotal  [ci(killer)] = (ev.gpTotal  [ci(killer)] ?? 0) + gp;
    ev.kills    [ci(killer)] = (ev.kills    [ci(killer)] ?? 0) + 1;
    ev.deathCounts[ci(victim)] = (ev.deathCounts[ci(victim)] ?? 0) + 1;

    lootLog.push({ killer, gp, timestamp: now(), event: currentEvent });

    const total = currentEvent === "default"
        ? ev.gpTotal[ci(killer)]
        : ev.lootTotals[ci(killer)];

    const embed = new EmbedBuilder()
      .setTitle("💰 Loot Detected")
      .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields({
        name: currentEvent === "default" ? "Total GP Earned" : "Event GP Gained",
        value:`${total.toLocaleString()} coins (${abbreviateGP(total)} GP)`
      })
      .setColor(gp >= GOLD_THRESHOLD ? COLOR_GOLD : COLOR_NORMAL)
      .setThumbnail(EMBED_ICON).setTimestamp();

    if (!discordReady) await new Promise(r => client.once("ready", r));
    try {
      const ch = await client.channels.fetch(DISCORD_CHANNEL_ID).catch(() => null);
      if (ch?.isTextBased()) await ch.send({ embeds: [embed] });
      else console.error("[processLoot] channel not ready");
    } catch (e) { console.error("[processLoot] send failed:", e); }

    saveData();
    return res?.status(200).send("ok");
  } catch (e) {
    console.error("[processLoot] fatal:", e);
    if (res && !res.headersSent) res.status(500).send("err");
  }
}

// ─── express & /dink webhook ────────────────────────────────
const app    = express();
const upload = multer();
app.use(express.json());
app.use(express.text({ type:"text/*" }));

app.post("/dink",
  upload.fields([{ name:"payload_json", maxCount:1 }]),
  async (req, res) => {
    let raw = req.body?.payload_json;
    if (Array.isArray(raw)) raw = raw[0];
    if (!raw && Object.keys(req.body||{}).length) raw = JSON.stringify(req.body);
    if (!raw) return res.status(400).send("no payload_json");

    let data; try { data = JSON.parse(raw); }
    catch { return res.status(400).send("bad JSON"); }

    if (data.type !== "CHAT" ||
        !["CLAN_CHAT","CLAN_MESSAGE"].includes(data.extra?.type) ||
        typeof data.extra.message !== "string")
      return res.status(204).end();

    if ((data.clanName || data.extra.source || "").toLowerCase() !== "obby elite")
      return res.status(204).end();

    const msgText = data.extra.message.trim();
    const m = msgText.match(LOOT_RE);
    if (!m) return res.status(204).end();

    /* track viewer */
    seenByLog.push({
      player: data.playerName || "unknown",
      message: msgText,
      timestamp: now()
    });
    console.log(`[dink] saw loot message: ${msgText} (by ${data.playerName||"unknown"})`);

    /* de-dupe raw line */
    if (processedLoot.has(msgText)) return res.status(204).end();
    processedLoot.add(msgText);

    console.log("[dink] processing loot message:", msgText);
    await processLoot(m[1], m[2], Number(m[3].replace(/,/g,"")), msgText, res);
  });

// ─── command handler (all commands restored) ─────────────────
client.on(Events.MessageCreate, async msg => {
  try {
    if (msg.author.bot) return;
    const text = msg.content.trim();
    if (!text.startsWith("!")) return;

    msg.delete().catch(()=>{});
    if (!checkCooldown(msg.author.id))
      return sendEmbed(msg.channel, "⏳ Cooldown", "Wait a moment…");

    const [cmdRaw, ...args] = text.slice(1).split(/\s+/);
    const cmd = cmdRaw.toLowerCase();

    /* ---------- statistics ---------- */
    if (cmd === "hiscores") {
      let period = "all";
      if (["daily","weekly","monthly","all"].includes(args[0]?.toLowerCase()))
        period = args.shift().toLowerCase();
      const nameFilter = args.join(" ").toLowerCase() || null;

      const filtered = killLog.filter(e =>
        (currentEvent==="default" ? true : e.event===currentEvent) &&
        (period==="all" || now() - e.timestamp <=
          {daily:86_400_000,weekly:604_800_000,monthly:2_592_000_000}[period]));

      const tally = {};
      filtered.forEach(({ killer }) => {
        const k = killer.toLowerCase();
        if (nameFilter && k !== nameFilter) return;
        tally[k] = (tally[k]||0)+1;
      });
      const board = Object.entries(tally)
        .sort((a,b)=>b[1]-a[1]).slice(0,10);

      const emb = new EmbedBuilder()
        .setTitle(`🏆 Hiscores (${period})`)
        .setThumbnail(EMBED_ICON).setColor(0x004200).setTimestamp();
      if (!board.length) emb.setDescription("No kills in that period.");
      else board.forEach(([n,c],i)=>emb.addFields({name:`${i+1}. ${n}`,value:`Kills: ${c}`}));
      return msg.channel.send({ embeds:[emb] });
    }

    if (cmd === "lootboard") {
      let period = "all";
      if (["daily","weekly","monthly","all"].includes(args[0]?.toLowerCase()))
        period = args.shift().toLowerCase();
      const nameFilter = args.join(" ").toLowerCase()||null;

      const filtered = lootLog.filter(e =>
        (currentEvent==="default"?true:e.event===currentEvent) &&
        (period==="all" || now() - e.timestamp <=
          {daily:86_400_000,weekly:604_800_000,monthly:2_592_000_000}[period]));

      const sums = {};
      filtered.forEach(({ killer, gp }) => {
        const k = killer.toLowerCase();
        if (nameFilter && k !== nameFilter) return;
        sums[k] = (sums[k]||0)+gp;
      });
      const board = Object.entries(sums)
        .sort((a,b)=>b[1]-a[1]).slice(0,10);

      const emb = new EmbedBuilder()
        .setTitle(`💰 Lootboard (${period})`)
        .setThumbnail(EMBED_ICON).setColor(0x004200).setTimestamp();
      if (!board.length) emb.setDescription("No loot in that period.");
      else board.forEach(([n,g],i)=>
        emb.addFields({name:`${i+1}. ${n}`,value:`${g.toLocaleString()} (${abbreviateGP(g)})`}));
      return msg.channel.send({ embeds:[emb] });
    }

    if (cmd === "totalgp" || cmd === "totalloot") {
      const { gpTotal } = getEventData();
      const total = Object.values(gpTotal).reduce((s,v)=>s+v,0);
      return sendEmbed(
        msg.channel, "💰 Total Loot",
        `${total.toLocaleString()} coins (${abbreviateGP(total)} GP)`);
    }

    /* ---------- manual GP adjustments ---------- */
    if (cmd === "addgp" || cmd === "removegp") {
		const amtRaw = args.pop();           // last token = amount
		const name   = args.join(" ");       // everything else = player name
      if (!name || !amtRaw)
        return sendEmbed(msg.channel, "Usage",
          "`!addgp <player> <amount>`  or  `!removegp <player> <amount>`");

      const gp = parseGP(amtRaw);
      if (isNaN(gp) || gp <= 0)
        return sendEmbed(msg.channel, "⚠️ Amount",
          "Enter a positive number, e.g. `250k`, `1.2m`, `450000`");

      const delta = cmd === "removegp" ? -gp : gp;
      const ev    = getEventData();
      const key   = ci(name);

      ev.gpTotal   [key] = (ev.gpTotal   [key] ?? 0) + delta;
      ev.lootTotals[key] = (ev.lootTotals[key] ?? 0) + delta;

      /* keep leaderboard periods accurate */
      lootLog.push({
        killer    : name,
        gp        : delta,
        manual    : true,
        timestamp : now(),
        event     : currentEvent
      });

      saveData();
      return sendEmbed(
        msg.channel,
        delta >= 0 ? "✅ GP Added" : "✅ GP Removed",
        `**${name}** adjusted by ${delta.toLocaleString()} coins ` +
        `(${abbreviateGP(Math.abs(delta))}).`
      );
    }
		

    /* ---------- event management ---------- */
    if (cmd === "listevents") {
      const list = Object.keys(events)
        .map(e => `• ${e}${e===currentEvent?" (current)":""}`).join("\n");
      return sendEmbed(msg.channel, "📅 Events", list || "No events.");
    }

    if (cmd === "createevent") {
      const name = args.join(" ").trim();
      if (!name || events[name])
        return sendEmbed(msg.channel, "⚠️ Event", "Invalid or duplicate name.");
      events[name]={ deathCounts:{},lootTotals:{},gpTotal:{},kills:{} };
      currentEvent=name; saveData();
      return sendEmbed(msg.channel,"📅 Event Created",`**${name}** is now current.`);
    }

    if (cmd === "finishevent") {
      const file = `events/event_${currentEvent}_${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
      fs.mkdirSync(path.dirname(path.join(__dirname,file)),{recursive:true});
      fs.writeFileSync(path.join(__dirname,file),JSON.stringify(events[currentEvent],null,2));
      delete events[currentEvent];
      currentEvent="default"; saveData();
      return sendEmbed(msg.channel,"✅ Event Finished",`Saved to \`${file}\`.`);
    }

    /* ---------- reset commands ---------- */
    if (cmd === "reset") {
      const target = args.join(" ").toLowerCase();
      if (!target) return sendEmbed(msg.channel,"Usage","`!reset <player>`");

      const ev=getEventData();
      delete ev.kills[target]; delete ev.lootTotals[target];
      delete ev.gpTotal[target]; delete ev.deathCounts[target];

      killLog.splice(0,killLog.length,...killLog.filter(e=>
        e.killer.toLowerCase()!==target&&e.victim.toLowerCase()!==target));
      lootLog.splice(0,lootLog.length,...lootLog.filter(e=>e.killer.toLowerCase()!==target));

      saveData();
      return sendEmbed(msg.channel,"🔄 Player Reset",`Stats for **${target}** wiped.`);
    }

    if (cmd === "resetall") {
      killLog.length=lootLog.length=0;
      Object.keys(events).forEach(k=>delete events[k]);
      events.default={deathCounts:{},lootTotals:{},gpTotal:{},kills:{}};
      currentEvent="default"; saveData();
      return sendEmbed(msg.channel,"🔄 Reset Complete","All data wiped.");
    }

    /* ---------- seenby ---------- */
    if (cmd === "seenby") {
      let count = Number(args[0]); if (isNaN(count)||count<1) count=10;
      const names=[...new Set(seenByLog.slice(-count).map(x=>x.player))];
      return sendEmbed(msg.channel, `👀 Seen By (${names.length})`, names.join(", ")||"None");
    }

    /* ---------- help ---------- */
    if (cmd === "help") {
      const emb=new EmbedBuilder()
        .setTitle("🛠 Commands")
        .setColor(0x004200).setThumbnail(EMBED_ICON).setTimestamp()
        .setDescription(
          "**Stats**\n"+
          "• `!hiscores [period] [name]`\n"+
          "• `!lootboard [period] [name]`\n"+
          "• `!totalgp`\n\n"+
          "**Misc**\n"+
          "• `!seenby [n]`\n• `!help`");
      return msg.channel.send({embeds:[emb]});
    }

  } catch (e) { console.error("[cmd] error:", e); }
});

// ─── start-up ────────────────────────────────────────────────
loadData();
setInterval(saveData,BACKUP_INTERVAL);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[http] listening on ${PORT}`));
client.login(DISCORD_BOT_TOKEN);
