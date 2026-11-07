const KEY='inpx.performance.preferences.v1';
const selections=['economy','balanced','performance','custom','compare'];
const limitKeys=['total','images','reviews','conversions'];
function normalizeDraft(value) {
    if(!value || !selections.includes(value.selected))return null;
    const result={selected:value.selected,sourceId:typeof value.sourceId==='string' && value.sourceId.length<=128 ? value.sourceId:''};
    if(value.customLimits==null)result.customLimits=null;
    else if(limitKeys.every(key=>value.customLimits[key]==='' || typeof value.customLimits[key]==='number'
        && Number.isFinite(value.customLimits[key]) && Math.abs(value.customLimits[key])<=1000000))
        result.customLimits=Object.fromEntries(limitKeys.map(key=>[key,value.customLimits[key]]));
    else return null;
    return result;
}
function preferenceScope(config={},settings={}) {
    const profile=config.currentUserProfile || {};
    if(!config.profileAuthorized || !profile.isAdmin)return '';
    const user=String(settings.currentUserId || profile.id || config.currentUserId || '');
    if(!user || user.length>128 || profile.id && String(profile.id)!==user || config.currentUserId && String(config.currentUserId)!==user)return '';
    return JSON.stringify([String(config.rootPathStatic || '').slice(0,256),user]);
}
class PerformancePreferences {
    constructor(storage=()=>typeof localStorage==='undefined' ? null:localStorage) {this.storage=storage;this.available=true;}
    entries() {
        try {
            const storage=this.storage();if(!storage){this.available=false;return [];}
            const raw=storage.getItem(KEY);this.available=true;
            if(!raw || raw.length>32768)return [];
            const value=JSON.parse(raw);
            return value?.version===1 && Array.isArray(value.entries) ? value.entries.filter(entry=>
                typeof entry.scope==='string' && entry.scope.length<=768 && normalizeDraft(entry.draft))
                .slice(-20).map(entry=>({scope:entry.scope,draft:normalizeDraft(entry.draft)})):[];
        } catch (_) {this.available=false;return [];}
    }
    read(scope) {
        if(!scope)return null;
        const entry=this.entries().find(entry=>entry.scope===scope);
        return normalizeDraft(entry?.draft);
    }
    write(scope,draft) {
        const value=normalizeDraft(draft);
        if(!scope || scope.length>768 || !value)return false;
        try {
            const entries=this.entries().filter(entry=>entry.scope!==scope);
            entries.push({scope,draft:value});
            this.storage().setItem(KEY,JSON.stringify({version:1,entries:entries.slice(-20)}));
            this.available=true;return true;
        } catch (_) {this.available=false;return false;}
    }
}
function testOptions(draft) {
    const options={sourceId:draft.sourceId};
    if(draft.selected==='custom')return {...options,mode:'custom',limits:Object.fromEntries(limitKeys.map(key=>[key,draft.customLimits?.[key]]))};
    if(draft.selected==='compare')return {...options,mode:'compare'};
    return {...options,mode:'profile',profileId:draft.selected};
}
module.exports={PerformancePreferences,preferenceScope,normalizeDraft,testOptions,KEY};
