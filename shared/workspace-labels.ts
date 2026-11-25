export const workspaceLabelKeys=[
 'overview','actions','tasks','calendar','approvals','bot','analytics','checks','reports','people','journal',
 'delegations','org','processes','okb','catalog','settings','guide','notifications',
 'analytics.remaining','analytics.completedDay','analytics.completedWeek','analytics.morning','analytics.waiting','analytics.teams'
] as const;
export type WorkspaceLabelKey=typeof workspaceLabelKeys[number];
export type WorkspaceLabels=Partial<Record<WorkspaceLabelKey,string>>;
