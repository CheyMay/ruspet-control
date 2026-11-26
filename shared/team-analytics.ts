export type AnalyticsAccess='company'|'sales'|'team';

export const analyticsDeadlineParts=['overdue','today','nextWorkday','later','withoutDeadline'] as const;
export const analyticsMorningProgressParts=['completed','review','rescheduled','discussed','other','untouched'] as const;
export type AnalyticsDeadlinePart=typeof analyticsDeadlineParts[number];
export type RemainingWork=Record<AnalyticsDeadlinePart|'total',number>;
export type CompletedWork=RemainingWork;
export const analyticsMetrics=[
 'remaining','completed','approvals','review','morning','worked','untouched','waiting',
 ...analyticsDeadlineParts.map(part=>`remaining:${part}` as const),
 ...analyticsDeadlineParts.map(part=>`completed:${part}` as const),
 ...analyticsDeadlineParts.map(part=>`morning:${part}` as const),
 ...analyticsMorningProgressParts.map(part=>`morning-progress:${part}` as const)
] as const;
export type AnalyticsMetric=typeof analyticsMetrics[number];
export const waitingStages=['approval','clarification','review','assignment'] as const;
export type WaitingStage=typeof waitingStages[number];
export type AnalyticsWait={stage:WaitingStage;userId:string;name:string;count:number;oldest:string|null};
export type AnalyticsMorning={total:number;worked:number;untouched:number;deadlines:RemainingWork;
 progress:Record<typeof analyticsMorningProgressParts[number],number>};
export type AnalyticsSelection={ids:string[];total:number};
export const analyticsColumns=['person','remaining','overdue','today','next','later','withoutDeadline','completed','approvals','review'] as const;
export type AnalyticsColumn=typeof analyticsColumns[number];
export type AnalyticsLayout=Partial<Record<AnalyticsColumn,number>>;
export type AnalyticsNumbers={
 remaining:RemainingWork;completed:CompletedWork;approvals:number;review:number;outside?:number;
};
export type AnalyticsGroup={key:string;label:string;caption?:string};
export type AnalyticsRow=AnalyticsGroup&{numbers:AnalyticsNumbers};
export type AnalyticsDay={date:string;completed:number};
export type AnalyticsOverview={
 access:AnalyticsAccess;scope:string;path:AnalyticsGroup[];rows:AnalyticsRow[];numbers:AnalyticsNumbers;
 days:AnalyticsDay[];generatedAt:string;date:string;nextWorkday:string;morning:AnalyticsMorning|null;waiting:AnalyticsWait[];
 historyFrom:string|null;partialHistory:boolean;bitrixDelay:boolean;
};
