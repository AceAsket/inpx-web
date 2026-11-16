const {lifetime} = require('./WebAccessChallenges');

class LegacyWebAccessSessions {
    constructor(challenges, timeout, write) {
        this.challenges = challenges;
        this.timeout = timeout;
        this.write = write;
        this.rows = new Map();
        this.pendingRemovals = new Set();
    }

    restore(sessions) {
        for (const [token,{time,used}] of sessions)
            this.rows.set(token,{time,used,saved:true,persisted:true});
    }

    writeChanges(updates, removals) {
        const values = updates.map(([token,row])=>{
            row.saved = true;
            return [token,{time:row.time,used:row.used}];
        });
        return this.write(values,removals,success=>{
            if (success) {
                for (const token of removals) this.pendingRemovals.delete(token);
            } else {
                for (const [token,row] of updates)
                    if (this.rows.get(token)===row) row.saved = false;
            }
        });
    }

    use(token, now) {
        let row = this.rows.get(token);
        if (!row && this.challenges.take(token,now)) {
            row = {time:now,used:0};
            this.rows.set(token,row);
        }
        if (!row || !(this.timeout===0 || now-row.time<this.timeout)) return false;
        row.used++;
        row.time = now;
        row.saved = false;
        if (row.persisted) return true;
        row.saving ||= this.writeChanges([[token,row]],[]).then(()=>{ row.persisted = true; })
            .finally(()=>{ row.saving = null; });
        return {saved:row.saving,current:()=>this.rows.get(token)===row};
    }

    revoke(token) {
        this.challenges.remove(token);
        if (!this.rows.delete(token) && !this.pendingRemovals.has(token)) return;
        this.pendingRemovals.add(token);
        return this.writeChanges([],[token]);
    }

    flush(now) {
        this.challenges.prune(now);
        const updates = [];
        for (const [token,row] of this.rows) {
            const age = now-row.time;
            if (!(row.used>0 || age<lifetime) || !(this.timeout===0 || age<this.timeout)) {
                this.rows.delete(token);
                this.pendingRemovals.add(token);
            } else if (row.persisted && !row.saved) updates.push([token,row]);
        }
        return this.writeChanges(updates,[...this.pendingRemovals]);
    }

    get size() {return this.rows.size;}
}

module.exports = LegacyWebAccessSessions;
