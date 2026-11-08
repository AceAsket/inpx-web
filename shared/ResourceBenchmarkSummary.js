const finite=value=>typeof value==='number'&&Number.isFinite(value);
const count=value=>Number.isInteger(value)&&value>=0;
const number=value=>value.toLocaleString('ru-RU',{maximumFractionDigits:1});
const check=(value,maximum)=>({value:finite(value)&&value>=0?value:null,maximum,
    status:finite(value)&&value>=0?value<maximum?'pass':'fail':'unknown'});

function criteriaFor(report) {
    if(report.schema!==2||report.legacy||!report.criteria)return null;
    const value=report.criteria;
    if(!finite(value.probeP95Ms)||value.probeP95Ms<=0||!finite(value.timerLagP95Ms)||value.timerLagP95Ms<=0
        ||!finite(value.memoryRatio)||value.memoryRatio<=0||value.memoryRatio>1
        ||!Number.isInteger(value.minProbeSamples)||value.minProbeSamples<1)return null;
    return value;
}

function summarizeRow(row,criteria) {
    const result={profile:typeof row.profile==='string'?row.profile.slice(0,64):'',status:'insufficient',notes:[],checks:{}};
    if(row.completed===false){result.status='failed';result.notes.push('Тестовые операции завершились с ошибкой; этот набор не оценён.');return result;}
    if(row.completed!==true){result.notes.push('Нет завершённого измерения этого набора.');return result;}
    let insufficient=false,attention=false;
    const timeouts=count(row.probeTimeouts)?row.probeTimeouts:null,failures=count(row.probeFailures)?row.probeFailures:null;
    const successful=count(row.probeSuccessfulSamples)?row.probeSuccessfulSamples
        :count(row.probeSamples)&&timeouts!==null&&failures!==null&&row.probeSamples>=timeouts+failures
            ?row.probeSamples-timeouts-failures:null;
    result.checks.probes={successful,timeouts,failures,minimum:criteria?.minProbeSamples??null};
    if(timeouts>0){attention=true;result.notes.push(`Таймауты внутренней проверки отклика: ${timeouts}.`);}
    if(failures>0){attention=true;result.notes.push(`Ошибки внутренней проверки отклика: ${failures}.`);}
    if(timeouts===null||failures===null){insufficient=true;result.notes.push('В отчёте нет полных счётчиков таймаутов и ошибок проверки отклика.');}
    if(!criteria){insufficient=true;result.notes.push('Критерии этого отчёта не сохранены в актуальном формате; оценка по ним недоступна.');}
    else {
        const probe=result.checks.probe=check(row.probeP95Ms,criteria.probeP95Ms);
        const lag=result.checks.eventLoop=check(row.timerLagP95Ms,criteria.timerLagP95Ms);
        const memory=result.checks.memory=check(row.memoryRatio,criteria.memoryRatio);
        if(successful===null||successful<criteria.minProbeSamples){
            insufficient=true;result.notes.push(successful===null?'Число успешных проверок отклика неизвестно.'
                :`Успешных проверок отклика: ${successful}; нужно не меньше ${criteria.minProbeSamples}.`);
        }
        if(probe.status==='fail'){attention=true;result.notes.push(`Внутренний отклик p95: ${number(probe.value)} мс; критерий — меньше ${number(probe.maximum)} мс.`);}
        if(lag.status==='fail'){attention=true;result.notes.push(`Задержка цикла Node.js p95: ${number(lag.value)} мс; критерий — меньше ${number(lag.maximum)} мс.`);}
        if(memory.status==='fail'){attention=true;result.notes.push(`Пиковая доля памяти: ${number(memory.value*100)}%; критерий — меньше ${number(memory.maximum*100)}%.`);}
        if([probe,lag,memory].some(item=>item.status==='unknown')){insufficient=true;result.notes.push('Не все показатели отклика и запаса памяти измерены.');}
    }
    if(row.otherWork===true){insufficient=true;result.notes.push('Во время замеров наблюдались другие задачи сервера; результат предварительный.');}
    result.status=attention?'attention':insufficient?'insufficient':'pass';
    if(result.status==='pass')result.notes.push('Измеренные показатели укладываются в сохранённые критерии этой проверки.');
    return result;
}

function summarizeReport(input) {
    const report=input&&typeof input==='object'?input:{},criteria=criteriaFor(report);
    const mode=['compare','custom','profile'].includes(report.mode)?report.mode:'unknown';
    const prefix=mode==='custom'?'Свои значения':mode==='profile'?'Выбранный профиль':mode==='compare'?'Сравнение профилей':'Результаты проверки';
    const source=Array.isArray(report.rows)?report.rows.slice(0,16):[];
    const rows=source.map(row=>summarizeRow(row&&typeof row==='object'?row:{},criteria));
    const notes=[];
    if(mode==='custom')notes.push('Проверен один набор своих значений. Сравнение профилей не выполнялось; действующие настройки не менялись.');
    else if(mode==='profile')notes.push('Проверен один выбранный профиль. Для выбора между профилями запустите их сравнение; действующие настройки не менялись.');
    else if(mode==='compare')notes.push('Сравнение использует медиану повторных проходов; время второго прохода показано отдельно.');
    else notes.push('Режим проверки не сохранён; сравнение профилей не подтверждено.');
    let status=rows.length&&rows.every(row=>row.status==='failed')?'failed'
        :rows.some(row=>['attention','failed'].includes(row.status))?'attention'
            :!rows.length||rows.some(row=>row.status==='insufficient')?'insufficient':'pass';
    const legacy=report.schema!==2||report.legacy===true;
    if(legacy){notes.push('Это отчёт прежнего формата. Повторите проверку для оценки по актуальным критериям.');status='insufficient';}
    if(report.stale){notes.push('Окружение или источник изменились; сохранённые результаты относятся к прежним условиям.');status='insufficient';}
    if(report.confidence==='partial'){
        notes.push('Охват ресурсов или нагрузок неполный либо наблюдалась другая работа; вывод предварительный.');
        if(status==='pass')status='insufficient';
    }
    if(mode==='compare'&&source.length<2){notes.push('Нет результатов хотя бы двух наборов для сравнения.');if(status==='pass')status='insufficient';}
    if(!rows.length)notes.push('Завершённых результатов пока нет.');
    const workloads=source.filter(row=>row&&count(row.tasksPerPass)&&count(row.tasksPerStage));
    if(workloads.length===1)notes.push(`За проход: ${workloads[0].tasksPerPass} тестовых операций, по ${workloads[0].tasksPerStage} на вид нагрузки. Для сравнения времени нужен одинаковый объём операций.`);
    const scope=report.machine?.memoryScope;
    if(scope==='process')notes.push('Память Node.js и CPU процесса не охватывают отдельные процессы конвертеров.');
    else if(scope==='host')notes.push('Показатели общей группы процессов могут включать другую работу на машине.');
    let conclusion=status==='pass'?'показатели укладываются в критерии теста'
        :status==='failed'?'тестовые операции завершились с ошибкой'
            :status==='insufficient'?'данных недостаточно для полной оценки':'не все критерии выполнены';
    if(status==='attention'&&mode!=='compare'){
        if(rows.some(row=>row.checks.probes?.timeouts>0))conclusion='есть таймауты проверки отклика';
        else if(rows.some(row=>row.checks.probes?.failures>0))conclusion='есть ошибки проверки отклика';
        else if(rows.some(row=>row.checks.probe?.status==='fail'))conclusion='отклик выше порога проверки';
        else if(rows.some(row=>row.checks.eventLoop?.status==='fail'))conclusion='задержка Node.js выше порога проверки';
        else if(rows.some(row=>row.checks.memory?.status==='fail'))conclusion='доля памяти выше порога проверки';
    }
    if(report.stale)conclusion='результаты относятся к прежним условиям';
    return {title:`${prefix}: ${conclusion}`,notes,status,mode,rows};
}

module.exports={summarizeReport};
