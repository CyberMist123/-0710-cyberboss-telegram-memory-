const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { acquireWriterLease, releaseWriterLease } = require("../orchestration/writer-lease");
const { backupFile, loadJson, replaceTextAtomic, writeJsonAtomic } = require("../continuity/continuity-store");
const DAILY_LIMIT = 10;
class MemoryNoteService {
  constructor({ continuityDir, now = () => new Date() } = {}) { this.dir = String(continuityDir || "").trim(); this.now = now; }
  note({ text, quote } = {}) {
    const body = clean(text, 1000), quoted = clean(quote, 500); if (!body) return { error: "invalid_note" };
    const p = { notes:path.join(this.dir,"ai_self_notes.md"), budget:path.join(this.dir,".jobs","memory-note-budget.json"), audit:path.join(this.dir,".jobs","memory-note-audit.jsonl"), lease:path.join(this.dir,".jobs","memory-note-writer-lease.json"), backups:path.join(this.dir,".backups") };
    let lease; try { lease = acquireWriterLease(p.lease, { writer:"memory-note", model:"subject-runtime", phase:"fable", branch:"feat/fable-wishlist-20260713", worktree:this.dir, base_sha:"0".repeat(40) }, { recoverStale:true }); } catch { return { error:"note_unavailable" }; }
    try { const date=this.now().toISOString().slice(0,10), budget=loadJson(p.budget,{days:{}}), used=Number(budget.days?.[date]?.count||0); if(used>=DAILY_LIMIT) return {error:"budget_exhausted",budget:{date,limit:DAILY_LIMIT,remaining:0}};
      const line=quoted?`[收藏] "${quoted}" —— 她，${this.now().toISOString().slice(0,16).replace("T"," ")}\n${body}`:`${body} —— ${this.now().toISOString().slice(0,16).replace("T"," ")}`; const current=read(p.notes); backupFile(p.notes,p.backups); replaceTextAtomic(p.notes,`${current}${current&&!current.endsWith("\n")?"\n":""}${line}\n`);
      budget.days=budget.days||{}; budget.days[date]={count:used+1,updated_at:this.now().toISOString()}; writeJsonAtomic(p.budget,budget); fs.mkdirSync(path.dirname(p.audit),{recursive:true}); fs.appendFileSync(p.audit,`${JSON.stringify({ts:this.now().toISOString(),date,chars:chars(body),quote_chars:chars(quoted),hash:hash(line)})}\n`,"utf8"); return {ok:true,budget:{date,limit:DAILY_LIMIT,remaining:DAILY_LIMIT-used-1}};
    } finally { releaseWriterLease(p.lease,lease.lease_id); }
  }
}
function clean(v,n){const x=String(v||"").trim();return chars(x)<=n?x:"";} function chars(v){return Array.from(String(v||"").replace(/\s/gu,"")).length;} function read(f){try{return fs.readFileSync(f,"utf8")}catch{return ""}} function hash(v){return crypto.createHash("sha256").update(v,"utf8").digest("hex");}
module.exports={DAILY_LIMIT,MemoryNoteService};
