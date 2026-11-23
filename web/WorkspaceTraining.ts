import training from '../shared/workspace-training.json';
import type {WorkspacePage} from '../shared/workspace-access.js';
import type {ReportView} from '../shared/report-parameters.js';

export const tracks=training.tracks;
export type TrainingTrack=keyof typeof tracks;
type LessonId=keyof typeof training.lessons;
type CardTab='info'|'result';
type Location={page:WorkspacePage;anchor:string;fallback?:string;card?:CardTab;scope?:ReportView};
export type TourStep=Location & (typeof training.lessons)[LessonId] & {id:LessonId};

const team:Location={page:'tasks',anchor:'.team-summary',fallback:'.task-scope-switches',scope:'team'};
const analytics:Location={page:'analytics',anchor:'.bi-summary',fallback:'[aria-label="Период аналитики"]'};
const approvals:Location={page:'approvals',anchor:'[aria-label="Тип согласования"]',fallback:'[aria-label="Показать согласования"]'};
const review:Location={page:'tasks',anchor:'.task-scope-switches',scope:'created'};
const reports:Location={page:'reports',anchor:'.report-presets',fallback:'.report-archive'};
const phone:Location={page:'bot',anchor:'.bot-buttons',fallback:'.mobile-bot-nav'};
const locations:Record<LessonId,Location>={
 priorities:{page:'overview',anchor:'.personal-metrics button:first-child'},
 accept:{page:'tasks',anchor:'.personal-task-plan',fallback:'.task-card .task-facts, .task-scope-switches',card:'info',scope:'mine'},
 calendar:{page:'calendar',anchor:'.calendar-title'},
 move:{page:'tasks',anchor:'.task-card-buttons',fallback:'.task-scope-switches',card:'info',scope:'mine'},
 submit:{page:'tasks',anchor:'.task-card [data-tab="result"]',fallback:'.task-scope-switches',card:'result',scope:'mine'},
 place:{page:'tasks',anchor:'.heading-actions .button.primary',fallback:'.task-scope-switches'},
 created:review,
 voice:{page:'bot',anchor:'.bot-compose'},
 clients:{page:'okb',anchor:'[aria-label="Поиск по ОКБ"]'},
 team,teamAnalytics:analytics,branchDecision:approvals,review,teamReport:{...reports,scope:'team'},
 salesAnalytics:analytics,companyAnalytics:analytics,week:{...analytics,anchor:'[aria-label="Период аналитики"]',fallback:'.bi-header'},
 directorDecision:approvals,companyReport:{...reports,scope:'company'},
 phonePriorities:{...phone,anchor:'.mobile-bot-nav button:last-child'},
 phoneAccept:phone,phoneMove:{...phone,anchor:'.mobile-bot-nav button:nth-last-child(2)'},phoneSubmit:phone,
 phoneVoice:{...phone,anchor:'.mobile-bot-nav',fallback:'.bot-compose'},
 phoneTeam:phone,phoneSales:{...phone,anchor:'.mobile-analytics-link'},phoneDecision:phone,phoneTeamReport:phone,phoneCompany:phone,phoneCompanyReport:phone
};

export function trainingSteps(track:TrainingTrack,mobile:boolean,enabled:(page:WorkspacePage)=>boolean,preview:boolean){
 const ids=[...tracks[track][mobile?'mobile':'desktop']] as LessonId[];
 return ids.map(id=>({id,...training.lessons[id],...locations[id]})).filter(step=>enabled(step.page)&&(!preview||step.page!=='reports'));
}
