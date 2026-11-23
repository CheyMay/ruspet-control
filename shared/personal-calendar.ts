import type {Task,User} from './types.js';

export type TaskPersonalPlan={
 epoch:number;revision:number;needsAcceptance:boolean;acceptedAt:string|null;plannedAt:string|null;nextStep?:string;
};
export type CalendarDeadline=Pick<Task,'id'|'title'|'deadline'|'status'>;
export type CalendarTask=CalendarDeadline & {plan:TaskPersonalPlan};
export type StaffWorkDay={date:string;minutes:number|null;note:string;revision:number};
export type PersonalCalendarMonth={
 today:string;deadlines?:CalendarDeadline[];scheduled:CalendarTask[];awaiting:CalendarTask[];work:StaffWorkDay[];canLogWork:boolean;
};

export const isSalesManager=(user:User)=>/менеджер\s+по\s+продажам/iu.test(user.position);
export const canLogStaffWork=(user:User)=>!user.root_access&&!isSalesManager(user);
export const moscowClock=(value:string|Date)=>new Date(+new Date(value)+3*3600000).toISOString().slice(0,16);
