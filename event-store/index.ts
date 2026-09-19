import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import type { AgentEvent, RunId } from "@mooncode/contracts";
const canonical = (v: unknown) => JSON.stringify(v);
export class JsonlEventStore {
  private seq = 0; private previousHash: string | null = null;
  constructor(private readonly file: string) {}
  async append(runId: RunId, type: string, payload: unknown): Promise<AgentEvent> {
    const base={seq:++this.seq,id:randomUUID(),timestamp:new Date().toISOString(),runId,type,payload,prevHash:this.previousHash};
    const hash=createHash("sha256").update(canonical(base)).digest("hex"); const event={...base,hash} as AgentEvent;
    await appendFile(this.file,`${canonical(event)}\n`,"utf8"); this.previousHash=hash; return event;
  }
  async readAll(): Promise<AgentEvent[]> { try{return (await readFile(this.file,"utf8")).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x) as AgentEvent);}catch(e:unknown){if((e as NodeJS.ErrnoException).code==="ENOENT")return[];throw e;} }
  async verify(): Promise<{valid:boolean;reason?:string}>{const events=await this.readAll();let prev:string|null=null;for(let i=0;i<events.length;i++){const e=events[i];if(e.seq!==i+1||e.prevHash!==prev)return{valid:false,reason:`link mismatch at ${e.seq}`};const{hash,...base}=e;if(hash!==createHash("sha256").update(canonical(base)).digest("hex"))return{valid:false,reason:`hash mismatch at ${e.seq}`};prev=hash;}return{valid:true};}
}
