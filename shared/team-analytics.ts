import type {Status} from './types.js';

export type AnalyticsAccess='company'|'sales'|'team';
export const analyticsMetricLabels={
 front:'К работе',closed:'Закрыто из фронта',remaining:'Осталось',overdue:'Просрочено',
 earlier:'Просрочки прошлых дней',expired:'Срок истёк сегодня',due:'Срок ещё сегодня',
 moved:'Перенесено с дня',waiting:'Ждут решения',unaccepted:'Нужно принять',
 tomorrow:'Срок завтра',closedAll:'Закрыто всего',onTime:'Закрыто в срок',late:'Закрыто с опозданием',
 unknown:'Закрыто без подтверждённого срока',idle:'Просрочки без движения',stuck:'Долго ждут решения'
} as const;
export type AnalyticsMetric=keyof typeof analyticsMetricLabels;
export type AnalyticsNumbers=Record<AnalyticsMetric,string[]>;
export type AnalyticsGroup={key:string;label:string;caption?:string};
export type AnalyticsRow=AnalyticsGroup&{numbers:AnalyticsNumbers;navigable:boolean};
export type AnalyticsDay={date:string;numbers:AnalyticsNumbers;live:boolean};
export type AnalyticsAttention={id:string;title:string;person:string;label:string;since:string|null;kind:'stuck'|'idle';nativeCard:boolean};
export type AnalyticsOverview={
 access:AnalyticsAccess;scope:string;path:AnalyticsGroup[];rows:AnalyticsRow[];numbers:AnalyticsNumbers;
 days:AnalyticsDay[];attention:AnalyticsAttention[];generatedAt:string;date:string;
 historyFrom:string|null;partialHistory:boolean;bitrixDelay:boolean;
};
export type AnalyticsTask={
 id:string;title:string;status:Status;deadline:string|null;assignee:string;creator:string;
 branch:string;next:string|null;nextPerson:string|null;nativeCard:boolean;description:string;lastRemark:string|null;
};
