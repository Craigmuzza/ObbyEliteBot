// oebot.js
import express from "express";
import { spawn, spawnSync } from "child_process";
import multer from "multer";
import { fileURLToPath } from "url";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  Collection
} from "discord.js";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

/* ─────────────────── paths & git helper ─────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DATA_DIR   = "/data";

(function fixOrigin () {
  try {
    spawnSync("git", [
      "remote","set-url","origin",
      "https://github.com/Craigmuzza/ObbyEliteBot.git"
    ],{ cwd:__dirname, stdio:"inherit" });
  } catch {}
})();
(function setGitIdentity () {
  try {
    spawnSync("git", ["config","user.email","bot@localhost"],{ cwd:__dirname });
    spawnSync("git", ["config","user.name","OE Loot Bot"],   { cwd:__dirname });
  } catch {}
})();

/* ─────────────────── env ─────────────────── */
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GITHUB_PAT         = process.env.GITHUB_PAT;
const REPO   = "craigmuzza/ObbyEliteBot";
const BRANCH = "main";
const COMMIT_MSG = "auto: sync data";

/* ─────────────────── constants ─────────────────── */
const EMBED_ICON = "https://i.imgur.com/qhpxVOw.gif";
const DEDUP_MS   = 10_000;
const BACKUP_INTERVAL = 5 * 60 * 1000;   // 5 min between automatic saves
const GOLD_THRESHOLD = 10_000_000;
const COLOR_NORMAL  = 0x820000;
const COLOR_GOLD    = 0xFFD700;
const LOOT_RE = /^(.+?)\s+has\s+defeated\s+(.+?)\s+and\s+received\s+\( *([\d,]+) *coins\).*$/i;

/* ─────────────────── runtime state ─────────────────── */
let currentEvent = "default";
const registered = new Set();            // (still used in processKill)
const seen       = new Map();            // anti-spam inside processLoot
const processedLoot = new Set();         // de-dupe /dink raw lines
const events = { default:{ deathCounts:{}, lootTotals:{}, gpTotal:{}, kills:{} } };
const killLog = [];
const lootLog = [];
const seenByLog = [];
const commandCooldowns = new Collection();

/* ─────────────────── helpers ─────────────────── */
const ci  = s => (s||"").toLowerCase().trim();
const now = () => Date.now();
function abbreviateGP (n){
  if (n>=1e9) return (n/1e9).toFixed(2).replace(/\.?0+$/,"")+"B";
  if (n>=1e6) return (n/1e6).toFixed(2).replace(/\.?0+$/,"")+"M";
  if (n>=1e3) return (n/1e3).toFixed(2).replace(/\.?0+$/,"")+"K";
  return String(n);
}
function sendEmbed (ch,title,desc,color=0x4200){
  return ch.send({ embeds:[ new EmbedBuilder()
      .setTitle(title).setDescription(desc).setColor(color)
      .setThumbnail(EMBED_ICON).setTimestamp() ]});
}

/* ─────────────────── git save helper ─────────────────── */
let gitTimer = null;
function queueGitCommit() {
  if (!GITHUB_PAT) return;
  if (gitTimer) return;

  gitTimer = setTimeout(() => {
    gitTimer = null;
    const opts = { cwd: __dirname, stdio: "ignore", detached: true };

    spawnSync("git", ["add", "."], opts);
    spawnSync("git", ["commit", "-m", COMMIT_MSG], opts);

    // new line – make our local HEAD equal to origin/main first
    spawnSync("git", ["pull", "--rebase", "--ff-only"], opts);

    const url = `https://x-access-token:${GITHUB_PAT}@github.com/${REPO}.git`;
    const p   = spawn("git", ["push", url, BRANCH], opts);
    p.unref();                       // don’t block the event-loop
  }, 5 * 60_000);
}
/* ── data persistence ───────────────────────────── */
function saveData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(DATA_DIR, "state.json"),
      JSON.stringify(
        { currentEvent, events, killLog, lootLog, seenByLog },
        null,
        2
      )
    );

    queueGitCommit();          // schedule non-blocking git add/commit/push
  } catch (err) {
    console.error("[save] Failed to save data:", err);
  }
}

/* ─────────────────── discord client ─────────────────── */
const client = new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let discordReady=false;
client.once("ready",()=>{discordReady=true;console.log(`[discord] ready: ${client.user.tag}`);});
client.on("error",e=>console.error("[discord] error:",e));
client.on("disconnect",()=>console.log("[discord] disconnect"));

/* ─────────────────── core logic ─────────────────── */
function getEventData(){
  if(!events[currentEvent])
    events[currentEvent]={ deathCounts:{},lootTotals:{},gpTotal:{},kills:{} };
  return events[currentEvent];
}

async function processLoot(killer,victim,gp,dedupKey,res){
  try{
    if(!killer||!victim||isNaN(gp)) return res?.status(400).send("bad data");
    if(seen.has(dedupKey)&&now()-seen.get(dedupKey)<DEDUP_MS)
      return res?.status(200).send("dup");
    seen.set(dedupKey,now());

    const ev=getEventData();
    ev.lootTotals[ci(killer)] = (ev.lootTotals[ci(killer)]||0)+gp;
    ev.gpTotal  [ci(killer)] = (ev.gpTotal  [ci(killer)]||0)+gp;
    ev.kills    [ci(killer)] = (ev.kills    [ci(killer)]||0)+1;
    ev.deathCounts[ci(victim)] = (ev.deathCounts[ci(victim)]||0)+1;

    lootLog.push({ killer,gp,timestamp:now(),event:currentEvent });

    /* build embed */
    const total = currentEvent==="default"? ev.gpTotal[ci(killer)] : ev.lootTotals[ci(killer)];
    const embed = new EmbedBuilder()
      .setTitle("💰 Loot Detected")
      .setDescription(`**${killer}** defeated **${victim}** and received **${gp.toLocaleString()} coins**`)
      .addFields({ name: currentEvent==="default"?"Total GP Earned":"Event GP Gained",
                   value:`${total.toLocaleString()} coins (${abbreviateGP(total)} GP)` })
      .setColor(gp>=GOLD_THRESHOLD?COLOR_GOLD:COLOR_NORMAL)
      .setThumbnail(EMBED_ICON).setTimestamp();

    /* wait for readiness & send */
    if(!discordReady) await new Promise(r=>client.once("ready",r));
    try{
      const ch = await client.channels.fetch(DISCORD_CHANNEL_ID).catch(()=>null);
      if(ch?.isTextBased()) await ch.send({embeds:[embed]});
      else console.error("[processLoot] channel not ready");
    }catch(e){ console.error("[processLoot] send failed:",e); }

    saveData();
    return res?.status(200).send("ok");
  }catch(e){
    console.error("[processLoot] fatal:",e);
    if(res&&!res.headersSent)res.status(500).send("err");
  }
}

const app = express();
const upload = multer();
app.use(express.json());
app.use(express.text({type:"text/*"}));

app.post("/dink",upload.fields([{name:"payload_json",maxCount:1}]),async(req,res)=>{
  let raw=req.body?.payload_json;
  if(Array.isArray(raw)) raw=raw[0];
  if(!raw&&Object.keys(req.body||{}).length) raw=JSON.stringify(req.body);
  if(!raw) return res.status(400).send("no payload_json");
  let data; try{data=JSON.parse(raw);}catch{return res.status(400).send("bad JSON");}

  if(data.type!=="CHAT"||!["CLAN_CHAT","CLAN_MESSAGE"].includes(data.extra?.type)||typeof data.extra.message!=="string")
    return res.status(204).end();

  if((data.clanName||data.extra.source||"").toLowerCase()!=="obby elite")
    return res.status(204).end();

  const msgText=data.extra.message.trim();
  const m=msgText.match(LOOT_RE);
  if(!m) return res.status(204).end();

  /* record viewer */
  seenByLog.push({player:data.playerName||"unknown",message:msgText,timestamp:now()});
  console.log(`[dink] saw loot message: ${msgText} (by ${data.playerName||"unknown"})`);

  if(processedLoot.has(msgText)) return res.status(204).end();
  processedLoot.add(msgText);
  console.log("[dink] processing loot message:",msgText);

  await processLoot(m[1],m[2],Number(m[3].replace(/,/g,"")),msgText,res);
});

/* ────────── mini cmd-handler (only reset & help kept for brevity) ───────── */
client.on(Events.MessageCreate,async msg=>{
  if(msg.author.bot) return;
  const text=msg.content.trim();
  if(!text.startsWith("!")) return;
  msg.delete().catch(()=>{});
  if(!checkCooldown(msg.author.id)){
    return sendEmbed(msg.channel,"Cooldown","Wait a bit.");
  }
  const [cmd,...args] = text.slice(1).split(/\s+/);

  if(cmd==="resetall"){
    killLog.length=lootLog.length=0;
    Object.keys(events).forEach(k=>delete events[k]);
    events.default={deathCounts:{},lootTotals:{},gpTotal:{},kills:{}};
    currentEvent="default"; saveData();
    return sendEmbed(msg.channel,"Reset","All data wiped.");
  }

  if(cmd==="help"){
    return sendEmbed(msg.channel,"Help","`!resetall` – wipe everything\n`!help` – this message");
  }
});

/* ────────── start ───────── */
loadData();
setInterval(saveData,BACKUP_INTERVAL);
const PORT=process.env.PORT||10000;
app.listen(PORT,()=>console.log(`[http] listening on ${PORT}`));
client.login(DISCORD_BOT_TOKEN);
