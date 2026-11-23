export type AnalyticsAccess='company'|'sales'|'team';

export type RemainingWork={total:number;overdue:number;today:number;nextWorkday:number};
export type CompletedWork=RemainingWork&{later:number;withoutDeadline:number};
export type AnalyticsNumbers={
 remaining:RemainingWork;completed:CompletedWork;approvals:number;review:number;outside?:number;
};
export type AnalyticsGroup={key:string;label:string;caption?:string};
export type AnalyticsRow=AnalyticsGroup&{numbers:AnalyticsNumbers};
export type AnalyticsDay={date:string;completed:number};
export type AnalyticsOverview={
 access:AnalyticsAccess;scope:string;path:AnalyticsGroup[];rows:AnalyticsRow[];numbers:AnalyticsNumbers;
 days:AnalyticsDay[];generatedAt:string;date:string;nextWorkday:string;
 historyFrom:string|null;partialHistory:boolean;bitrixDelay:boolean;
};
